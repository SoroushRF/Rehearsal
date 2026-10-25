import { randomUUID } from "node:crypto";
import type { Vendor } from "@rehearsal/contracts";
import {
  type BillingPolicy,
  type Clock,
  createCompensator,
  createReadGuard,
  type ExecutorDeps,
  executeRun,
  PLAN_LOCKED,
  type ProviderPort,
  type RunOutcome,
  type WorldContext,
} from "@rehearsal/core";
import { ApplyJob, type Db, loadRegistry, PgApplyStore, PgJournal } from "@rehearsal/db";

/** Everything the executor needs except the per-job store and journal. */
export interface WorkerContext {
  db: Db;
  providers: Partial<Record<Vendor, ProviderPort>>;
  worlds: Partial<Record<Vendor, WorldContext>>;
  clock: Clock;
  policies: readonly BillingPolicy[];
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
 * A run that can't finish (lock held, an error, a send it can't read back yet) stays `applying`
 * even past pg-boss's last try: the reaper re-enqueues it, bounded by MAX_REAPS, then hands it to
 * an operator and marks it failed. Nothing here marks a run failed on its own.
 */
export async function handleApplyJob(
  data: unknown,
  ctx: WorkerContext,
  /** Where this delivery is in pg-boss's retries. Logged by the caller; exhaustion is the reaper's. */
  _attempt?: JobAttempt,
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
    // Postgres, never Agent Memory: the executor holds no memory credentials.
    precedents: {
      snapshot: async (orgId) => (await loadRegistry(ctx.db, orgId)).snapshot,
    },
    newId: (prefix) => `${prefix}_${randomUUID()}`,
    guard: createReadGuard({ providers: ctx.providers, worlds: ctx.worlds, clock: ctx.clock }),
    compensate: createCompensator({
      providers: ctx.providers,
      worlds: ctx.worlds,
      clock: ctx.clock,
    }),
    ...ctx.executor,
  });

  if (!(await store.transitionRun(job.orgId, job.runId, ["approved", "applying"], "applying"))) {
    const state = await store.runState(job.orgId, job.runId);
    if (state === "cancelled") {
      // A cancelled run sends nothing, but the executor still resolves any earlier send whose
      // outcome is unknown through reads. Its state stays "cancelled".
      const outcome = await executeRun(job, deps());
      if (outcome.refusal === PLAN_LOCKED) throw new RetryLater(PLAN_LOCKED);
      // The read-only pass stopped on an error (journal down): try it again. The run stays
      // cancelled either way, and the reaper picks it up while a send is still in flight.
      if (outcome.error !== null) throw new RetryLater(outcome.error);
      // A send of the plan, perhaps under an older revision, still can't be read back: retry, so
      // a later read settles it or the reaper hands it to an operator. It stays cancelled.
      if (outcome.unresolved)
        throw new RetryLater("cancelled; an earlier send is still unresolved");
      return { kind: "ran", outcome };
    }
    return { kind: "skipped", reason: `run is ${state}` };
  }

  // A thrown error (journal down, an adapter bug) propagates: pg-boss retries, and the journal
  // makes the re-run safe. Past the last try the run stays `applying` for the reaper.
  const outcome: RunOutcome = await executeRun(job, deps());

  if (outcome.refusal === PLAN_LOCKED) {
    // The plan's lock is held: by another revision, or by an earlier delivery of this same job
    // that is still running and may have sent something this delivery can't see. Nothing
    // happened here, and the run stays `applying`, even past the last try: the holder's final
    // write still lands, and if the holder dies instead the reaper picks the run up (bounded by
    // MAX_REAPS, then `run.needs_operator`). Marking it failed here could strand its sends (#121).
    throw new RetryLater(PLAN_LOCKED);
  }
  if (outcome.error !== null) {
    // The executor stopped on an unexpected error (a failed journal write, an adapter bug). An
    // effect may have landed without a receipt, so its state is not the run's truth: retry, and
    // the next delivery reconciles through the journal and reads. Past the last try the run
    // stays `applying`: the reaper re-enqueues it a bounded number of times, then hands it to an
    // operator (`run.needs_operator`) and marks it failed. Marking it failed here would leave a
    // send with no receipt where nothing ever looks at it again.
    throw new RetryLater(outcome.error);
  }
  if (outcome.unresolved) {
    // Refused, but an earlier send of the run still can't be read back: keep the run `applying`
    // so it is read again, with the same bounded hand-off as an error.
    throw new RetryLater(`${outcome.refusal}; an earlier send is still unresolved`);
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
