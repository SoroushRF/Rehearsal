import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Db } from "./index";
import { APPLY_QUEUE, enqueueApply } from "./queue";
import { runs, stepAttempts } from "./schema";

export type CancelResult =
  | { kind: "cancelled"; runId: string }
  | { kind: "not_found" }
  | { kind: "not_active"; state: string };

/**
 * Stop a run that is waiting or applying. The executor sees it before the next step or send and
 * stops there; effects already applied keep their receipts (a refund is never rolled back).
 */
export async function requestCancel(
  db: Db,
  cmd: { orgId: string; runId: string },
): Promise<CancelResult> {
  const moved = await db
    .update(runs)
    .set({ state: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(runs.orgId, cmd.orgId),
        eq(runs.id, cmd.runId),
        inArray(runs.state, ["approved", "applying"]),
      ),
    )
    .returning({ id: runs.id });
  if (moved.length > 0) return { kind: "cancelled", runId: cmd.runId };
  const [row] = await db
    .select({ state: runs.state })
    .from(runs)
    .where(and(eq(runs.orgId, cmd.orgId), eq(runs.id, cmd.runId)));
  return row ? { kind: "not_active", state: row.state } : { kind: "not_found" };
}

/** pg-boss job states that mean someone will still run the job. */
const LIVE_JOB_STATES = ["created", "retry", "active"];

/**
 * Re-enqueue runs left `approved` or `applying` with no live job (a worker died on the job's last
 * attempt, or the job expired), and cancelled runs that still have a send in flight (they get a
 * read-only reconcile). Re-running is safe: the executor resumes from the journal and
 * never re-sends past an unknown outcome. One reaper acts at a time (transaction advisory lock).
 */
export async function reapStuckRuns(
  db: Db,
  boss: PgBoss,
  opts: { now: Date; staleAfterMs: number },
): Promise<string[]> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ ok: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtextextended('rehearsal:reaper', 0)) as ok`,
    );
    if (!rows[0]?.ok) return [];
    const cutoff = new Date(opts.now.getTime() - opts.staleAfterMs);
    const stuck = await tx
      .select()
      .from(runs)
      .where(
        and(
          or(
            inArray(runs.state, ["approved", "applying"]),
            // A cancelled run still owes a read-only reconcile of any send left in flight.
            and(
              eq(runs.state, "cancelled"),
              sql`exists (
                select 1 from ${stepAttempts} a
                where a.org_id = ${runs.orgId} and a.plan_hash = ${runs.planHash}
                  and a.state in ('dispatched', 'unknown_outcome')
              )`,
            ),
          ),
          lt(runs.updatedAt, cutoff),
          sql`not exists (
            select 1 from pgboss.job j
            where j.name = ${APPLY_QUEUE}
              and j.state::text in (${sql.join(
                LIVE_JOB_STATES.map((s) => sql`${s}`),
                sql`, `,
              )})
              and j.data->>'runId' = ${runs.id}
          )`,
        ),
      );
    for (const run of stuck) {
      await enqueueApply(boss, tx, {
        orgId: run.orgId,
        runId: run.id,
        planId: run.planId,
        revision: run.revision,
        planHash: run.planHash,
      });
      // Touch it so the next sweep waits a full window for this job to make progress.
      await tx.update(runs).set({ updatedAt: opts.now }).where(eq(runs.id, run.id));
    }
    return stuck.map((r) => r.id);
  });
}
