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
  executor?: Pick<ExecutorDeps, "retry" | "sleep" | "reconcileAfterMs">;
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
  if (!(await store.transitionRun(job.orgId, job.runId, ["approved", "applying"], "applying"))) {
    const state = await store.runState(job.orgId, job.runId);
    return { kind: "skipped", reason: `run is ${state}` };
  }

  const lastTry = attempt !== undefined && attempt.retryCount >= attempt.retryLimit;
  const giveUp = () => store.transitionRun(job.orgId, job.runId, ["applying"], "failed");

  let outcome: RunOutcome;
  try {
    outcome = await executeRun(job, {
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
  } catch (err) {
    // Journal down or an adapter bug. pg-boss retries; the journal makes the re-run safe.
    if (lastTry) await giveUp();
    throw err;
  }

  if (outcome.refusal === PLAN_LOCKED) {
    // Another revision of this plan is applying. Nothing happened here.
    if (lastTry) {
      await giveUp();
      return { kind: "ran", outcome: { ...outcome, state: "failed" } };
    }
    await store.transitionRun(job.orgId, job.runId, ["applying"], "approved");
    throw new RetryLater(PLAN_LOCKED);
  }
  await store.transitionRun(job.orgId, job.runId, ["applying"], outcome.state);
  return { kind: "ran", outcome };
}
