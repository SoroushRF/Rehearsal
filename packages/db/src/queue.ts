import { sql } from "drizzle-orm";
import { fromDrizzle, PgBoss } from "pg-boss";
import { z } from "zod";
import type { Db } from "./index";
import { withOrgWorlds } from "./org-world-lock";

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

/**
 * Which approved precedent version to publish to Agent Memory, or to overwrite there with the
 * withdrawal marker once it is withdrawn (T1.51). The worker loads the record itself. Jobs queued
 * before `kind` existed are publishes.
 */
export const PrecedentSyncJob = z.object({
  orgId: z.string().min(1),
  precedentId: z.string().min(1),
  version: z.int().positive(),
  kind: z.enum(["publish", "withdraw"]).default("publish"),
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

/** Seed and commit the plan job before a reset can check whether the org is idle. */
export function enqueuePlan(
  db: Db,
  boss: PgBoss,
  job: { orgId: string },
  before: () => Promise<void>,
): Promise<string | null> {
  return withOrgWorlds(db, job.orgId, async (tx) => {
    await before();
    return boss.send(PLAN_QUEUE, job, { db: fromDrizzle(tx, sql) });
  });
}

/**
 * Enqueue inside the caller's transaction, so the run row and its job commit or roll back
 * together. A crash can never leave a run with no job, or a job with no run.
 */
export async function enqueueApply(boss: PgBoss, tx: DrizzleTx, job: ApplyJob): Promise<void> {
  const id = await boss.send(APPLY_QUEUE, ApplyJob.parse(job), { db: fromDrizzle(tx, sql) });
  // A suppressed send would leave a run with no job; fail the transaction instead.
  if (!id) throw new Error(`apply job for ${job.runId} was not enqueued`);
}

/**
 * Enqueue inside the transaction that appends the event: the `approved` (or `withdrawn`) event and
 * its sync job commit together.
 */
export async function enqueuePrecedentSync(
  boss: PgBoss,
  tx: DrizzleTx,
  input: z.input<typeof PrecedentSyncJob>,
): Promise<void> {
  const job = PrecedentSyncJob.parse(input);
  // PRECEDENT_QUEUE has no policy, so pg-boss 12 doesn't dedupe on singletonKey alone: sending
  // the same job twice queues it twice. That's safe (the sync is idempotent: a repeat writes
  // nothing and appends no second event), only wasteful. `precedentSyncPending` checks first.
  await boss.send(PRECEDENT_QUEUE, job, {
    db: fromDrizzle(tx, sql),
    singletonKey: precedentSyncKey(job),
  });
}

/** The singleton key a precedent sync job is sent with: one per org, precedent, version and kind. */
export function precedentSyncKey(input: z.input<typeof PrecedentSyncJob>): string {
  const job = PrecedentSyncJob.parse(input);
  const key = `${job.orgId}:${job.precedentId}:${job.version}`;
  return job.kind === "publish" ? key : `${key}:${job.kind}`;
}

/**
 * True when the same sync job is already waiting, retrying or running, for a caller that may send
 * it again (the drift repair, T1.53). Takes a transaction-scoped lock on the key first, so two
 * callers that both check before sending can't both send.
 */
export async function precedentSyncPending(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  input: z.input<typeof PrecedentSyncJob>,
): Promise<boolean> {
  const key = precedentSyncKey(input);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`rehearsal:precedent-sync:${key}`}, 0))`,
  );
  const rows = await tx.execute(
    sql`select 1 from pgboss.job where name = ${PRECEDENT_QUEUE} and singleton_key = ${key} and state in ('created', 'retry', 'active') limit 1`,
  );
  return rows.rows.length > 0;
}

/**
 * pg-boss for an operator tool that only sends precedent sync jobs: no maintenance, schedule or
 * schema migration, and no queue created or updated (the API owns them). Throws when the API
 * hasn't created the precedent queue yet.
 */
export async function startPrecedentSender(url = process.env.DATABASE_URL): Promise<PgBoss> {
  if (!url) throw new Error("DATABASE_URL is not set");
  const boss = new PgBoss({
    connectionString: url,
    supervise: false,
    schedule: false,
    migrate: false,
    createSchema: false,
  });
  boss.on("error", (err) => console.error("pg-boss error", err));
  await boss.start();
  if ((await boss.getQueue(PRECEDENT_QUEUE)) === null) {
    await boss.stop({ graceful: false });
    throw new Error(`queue ${PRECEDENT_QUEUE} doesn't exist yet; start the API once first`);
  }
  return boss;
}
