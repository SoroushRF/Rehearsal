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

/** pg-boss keeps its tables in its own `pgboss` schema in the same database. */
export async function startQueue(url = process.env.DATABASE_URL): Promise<PgBoss> {
  if (!url) throw new Error("DATABASE_URL is not set");
  const boss = new PgBoss(url);
  boss.on("error", (err) => console.error("pg-boss error", err));
  await boss.start();
  await boss.createQueue(APPLY_QUEUE);
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
