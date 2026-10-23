import { randomUUID } from "node:crypto";
import type { Vendor } from "@rehearsal/contracts";
import {
  type BillingPolicyV1,
  type Clock,
  createReadGuard,
  type ExecutorDeps,
  executeRun,
  PLAN_LOCKED,
  type ProviderPort,
  type RunOutcome,
  type WorldContext,
} from "@rehearsal/core";
import { ApplyJob, type Db, PgApplyStore, PgJournal } from "@rehearsal/db";

/** Everything the executor needs except the per-job store and journal. */
export interface WorkerContext {
  db: Db;
  providers: Partial<Record<Vendor, ProviderPort>>;
  worlds: Partial<Record<Vendor, WorldContext>>;
  clock: Clock;
  policies: readonly BillingPolicyV1[];
  /** Overrides for tests (retry sleeps, the reconcile window). */
  executor?: Pick<ExecutorDeps, "retry" | "sleep" | "reconcileAfterMs" | "caseConcurrency">;
}

/** Thrown so pg-boss retries the job later; the run itself is fine. */
export class RetryLater extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryLater";
  }
}

/** Where this delivery stands in pg-boss's retries. */
export interface JobAttempt {
  retryCount: number;
  retryLimit: number;
}

export type ApplyJobResult =
  | { kind: "ran"; outcome: RunOutcome }
  /** Nothing was executed and no run state was written. */
  | { kind: "skipped"; reason: string };

/**
 * Run one `apply` job. The payload only names a stored run; it must match that run, and the run
 * must still be `approved` or `applying` (claimed by compare-and-set), so a stale or duplicate job
 * can't revive a finished or cancelled run. The executor's admission then re-checks everything.
 * On the last retry a run that couldn't finish is marked `failed`, so a new apply can resume it.
 */
export async function handleApplyJob(
  data: unknown,
  ctx: WorkerContext,
  attempt?: JobAttempt,
): Promise<ApplyJobResult> {
  const parsed = ApplyJob.safeParse(data);
  if (!parsed.success) return { kind: "skipped", reason: "malformed apply job" };
  const job = parsed.data;
  const store = new PgApplyStore(ctx.db);

  const run = await store.loadRun(job.orgId, job.runId);
  if (
    !run ||
    run.planId !== job.planId ||
    run.revision !== job.revision ||
    run.planHash !== job.planHash
  ) {
    return { kind: "skipped", reason: "job does not match a stored run" };
  }
  const deps = (): Parameters<typeof executeRun>[1] => ({
    store,
    journal: new PgJournal(ctx.db, job.orgId),
    providers: ctx.providers,
    worlds: ctx.worlds,
    clock: ctx.clock,
    policies: ctx.policies,
    newId: (prefix) => `${prefix}_${randomUUID()}`,
    guard: createReadGuard({ providers: ctx.providers, worlds: ctx.worlds, clock: ctx.clock }),
    ...ctx.executor,
  });

  if (!(await store.transitionRun(job.orgId, job.runId, ["approved", "applying"], "applying"))) {
    const state = await store.runState(job.orgId, job.runId);
    if (state === "cancelled") {
      // A cancelled run sends nothing, but the executor still resolves any earlier send whose
      // outcome is unknown through reads. Its state stays "cancelled".
      const outcome = await executeRun(job, deps());
      if (outcome.refusal === PLAN_LOCKED) throw new RetryLater(PLAN_LOCKED);
      return { kind: "ran", outcome };
    }
    return { kind: "skipped", reason: `run is ${state}` };
  }

  const lastTry = attempt !== undefined && attempt.retryCount >= attempt.retryLimit;
  const giveUp = async () => {
    if (!(await store.transitionRun(job.orgId, job.runId, ["applying"], "failed"))) {
      console.error(`run ${job.runId}: last retry, but it is no longer applying; left as is`);
    }
  };

  let outcome: RunOutcome;
  try {
    outcome = await executeRun(job, deps());
  } catch (err) {
    // Journal down or an adapter bug. pg-boss retries; the journal makes the re-run safe.
    if (lastTry) await giveUp();
    throw err;
  }

  if (outcome.refusal === PLAN_LOCKED) {
    // The plan's lock is held: by another revision, or by an earlier delivery of this same job
    // that is still running. Nothing happened here, and the run stays `applying` so the holder's
    // final write still lands. On the last try, mark it failed so a new apply can pick it up;
    // a holder that does finish this run still records its real outcome over that.
    if (lastTry) {
      await giveUp();
      return { kind: "ran", outcome: { ...outcome, state: "failed" } };
    }
    throw new RetryLater(PLAN_LOCKED);
  }
  // This delivery held the lock and ran: its outcome is the truth, even over an overlapping
  // delivery's last-try "failed". A cancelled or newer state is never overwritten.
  const written = await store.transitionRun(
    job.orgId,
    job.runId,
    ["applying", "failed"],
    outcome.state,
  );
  if (!written) {
    const now = await store.runState(job.orgId, job.runId);
    console.error(`run ${job.runId} finished ${outcome.state} but is ${now}; state not written`);
  }
  return { kind: "ran", outcome };
}
