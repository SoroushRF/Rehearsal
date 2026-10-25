import { sql } from "drizzle-orm";
import { fromDrizzle, PgBoss } from "pg-boss";
import { z } from "zod";

export type { PgBoss };

export const APPLY_QUEUE = "apply";

/** Job payloads cross a trust boundary: the worker re-validates them and loads its own manifest. */
export const ApplyJob = z.object({
  orgId: z.string().min(1),
  runId: z.string().min(1),
  planId: z.string().min(1),
  revision: z.int().positive(),
  planHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ApplyJob = z.infer<typeof ApplyJob>;

/**
 * A job may run more than once (a crash, a retry, a lock held by another revision). That is safe:
 * the executor resumes from the journal and never re-sends past an unknown outcome. So retry
 * generously with backoff, and give a run time to finish (retries sleep, reads reconcile).
 */
export const APPLY_QUEUE_OPTIONS = {
  retryLimit: 50,
  retryDelay: 5,
  retryBackoff: true,
  retryDelayMax: 300,
  expireInSeconds: 1800,
} as const;

export const PLAN_QUEUE = "plan";

// T1.5: the payload is `PlanJob` in @rehearsal/providers, shared with the planner worker, which
// reaches the queue only through the API (docs/decisions/0006-planner-jobs-through-api.md).

/**
 * Planning spends model tokens and produces a different plan each time, so it is retried once (a
 * worker that died mid-run), not fifty times. A run is bounded by its turn limit well inside this.
 */
export const PLAN_QUEUE_OPTIONS = {
  retryLimit: 1,
  retryDelay: 30,
  expireInSeconds: 900,
} as const;

export const PRECEDENT_QUEUE = "precedent-sync";

/** Which approved precedent version to publish to Agent Memory. The worker loads the record itself. */
export const PrecedentSyncJob = z.object({
  orgId: z.string().min(1),
  precedentId: z.string().min(1),
  version: z.int().positive(),
});
export type PrecedentSyncJob = z.infer<typeof PrecedentSyncJob>;

/**
 * Publishing is idempotent (writing the stored version again sends nothing), so retry for a good
 * while: an Agent Memory outage should delay activation, never lose the promotion.
 */
export const PRECEDENT_QUEUE_OPTIONS = {
  retryLimit: 20,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 900,
  expireInSeconds: 300,
} as const;

/**
 * Execution rehearsals (T3.13). Their own queue, never `apply`: a rehearsal job can't be consumed
 * by the operational executor. One job per rehearsal. A redelivery never resumes a rehearsal that
 * got past `queued` (decision 0013, §5): its claim fails, and a retry is a new rehearsal.
 */
export const REHEARSAL_QUEUE = "rehearsal";
export const REHEARSAL_QUEUE_OPTIONS = {
  retryLimit: 5,
  retryDelay: 15,
  retryBackoff: true,
  retryDelayMax: 300,
  expireInSeconds: 900,
} as const;

/** pg-boss keeps its tables in its own `pgboss` schema in the same database. */
export async function startQueue(url = process.env.DATABASE_URL): Promise<PgBoss> {
  if (!url) throw new Error("DATABASE_URL is not set");
  const boss = new PgBoss(url);
  boss.on("error", (err) => console.error("pg-boss error", err));
  await boss.start();
  await boss.createQueue(APPLY_QUEUE, APPLY_QUEUE_OPTIONS);
  // createQueue leaves an existing queue's settings alone; apply ours either way.
  await boss.updateQueue(APPLY_QUEUE, APPLY_QUEUE_OPTIONS);
  await boss.createQueue(PLAN_QUEUE, PLAN_QUEUE_OPTIONS);
  await boss.updateQueue(PLAN_QUEUE, PLAN_QUEUE_OPTIONS);
  await boss.createQueue(PRECEDENT_QUEUE, PRECEDENT_QUEUE_OPTIONS);
  await boss.updateQueue(PRECEDENT_QUEUE, PRECEDENT_QUEUE_OPTIONS);
  await boss.createQueue(REHEARSAL_QUEUE, REHEARSAL_QUEUE_OPTIONS);
  await boss.updateQueue(REHEARSAL_QUEUE, REHEARSAL_QUEUE_OPTIONS);
  return boss;
}

type DrizzleTx = Parameters<typeof fromDrizzle>[0];

/**
 * Enqueue inside the caller's transaction, so the run row and its job commit or roll back
 * together. A crash can never leave a run with no job, or a job with no run.
 */
export async function enqueueApply(boss: PgBoss, tx: DrizzleTx, job: ApplyJob): Promise<void> {
  const id = await boss.send(APPLY_QUEUE, ApplyJob.parse(job), { db: fromDrizzle(tx, sql) });
  // A suppressed send would leave a run with no job; fail the transaction instead.
  if (!id) throw new Error(`apply job for ${job.runId} was not enqueued`);
}

/** Enqueue inside the promotion's transaction: the `approved` event and its sync job commit together. */
export async function enqueuePrecedentSync(
  boss: PgBoss,
  tx: DrizzleTx,
  job: PrecedentSyncJob,
): Promise<void> {
  // A suppressed send means a job for this exact version is already queued, which is fine.
  await boss.send(PRECEDENT_QUEUE, PrecedentSyncJob.parse(job), {
    db: fromDrizzle(tx, sql),
    singletonKey: `${job.orgId}:${job.precedentId}:${job.version}`,
  });
}
