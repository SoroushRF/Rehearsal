import { sql } from "drizzle-orm";
import type { Db } from "./index";
import { runEvents } from "./schema";

/**
 * Append one run event. `seq` comes from a global sequence, so two writers of one run (two case
 * lanes, or a lane and the reaper) could commit out of order, and a reader tailing `seq > cursor`
 * would skip the one that commits late for good. Every writer takes this run's lock, held until
 * its transaction commits, before allocating a `seq`: per run, seq order is commit order.
 * `tx` must be a transaction (or a journal running inside one).
 */
export async function insertRunEvent(tx: Db, event: typeof runEvents.$inferInsert) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`rehearsal:run_events:${event.orgId}:${event.runId}`}, 0))`,
  );
  const [row] = await tx.insert(runEvents).values(event).returning();
  if (!row) throw new Error("run event insert returned no row");
  return row;
}
