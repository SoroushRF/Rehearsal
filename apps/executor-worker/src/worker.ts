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

/**
 * Run one `apply` job. The payload is re-validated and only names a stored run; the executor's
 * admission re-checks everything before anything is sent. The run's state follows the outcome.
 */
export async function handleApplyJob(data: unknown, ctx: WorkerContext): Promise<RunOutcome> {
  const job = ApplyJob.parse(data);
  const store = new PgApplyStore(ctx.db);
  const journal = new PgJournal(ctx.db, job.orgId);
  await store.setRunState(job.orgId, job.runId, "applying");

  const outcome = await executeRun(job, {
    store,
    journal,
    providers: ctx.providers,
    worlds: ctx.worlds,
    clock: ctx.clock,
    policies: ctx.policies,
    newId: (prefix) => `${prefix}_${randomUUID()}`,
    guard: createReadGuard({ providers: ctx.providers, worlds: ctx.worlds, clock: ctx.clock }),
    ...ctx.executor,
  });

  if (outcome.refusal === PLAN_LOCKED) {
    // Another revision of this plan is applying. Nothing happened; queue it again.
    await store.setRunState(job.orgId, job.runId, "approved");
    throw new RetryLater(PLAN_LOCKED);
  }
  await store.setRunState(job.orgId, job.runId, outcome.state);
  return outcome;
}
