import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "./index";
import { memoryErasureEvents } from "./schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Exec = Db | Tx;

export type MemoryErasureEventRow = typeof memoryErasureEvents.$inferSelect;

/**
 * Every process that writes an org's precedents to Agent Memory (the API's sync) holds this lock
 * shared for the length of its write, and `pnpm memory:erase-org` takes it exclusively to append
 * `erased`. So a sync that started before the erasure has finished writing by the time the event
 * commits, and is erased with the scope; one that starts after sees the event and writes nothing.
 */
export async function lockOrgMemoryShared(tx: Tx, orgId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock_shared(hashtextextended(${`rehearsal:org-memory:${orgId}`}, 0))`,
  );
}

async function lockOrgMemoryExclusive(tx: Tx, orgId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`rehearsal:org-memory:${orgId}`}, 0))`,
  );
}

/**
 * Whether the org's Agent Memory was erased (T1.55). From then on its precedents are never synced,
 * recalled, hinted or repaired; the registry in `precedent_events` is untouched and still decides.
 */
export async function memoryErased(db: Exec, orgId: string): Promise<boolean> {
  const [row] = await db
    .select({ seq: memoryErasureEvents.seq })
    .from(memoryErasureEvents)
    .where(and(eq(memoryErasureEvents.orgId, orgId), eq(memoryErasureEvents.kind, "erased")))
    .limit(1);
  return row !== undefined;
}

/**
 * Appends one erasure event. `erased` waits for any sync writing to the org's memory to finish
 * (`lockOrgMemoryShared`) and commits before the scope is forgotten. Never updates a row: running
 * the command again appends another pair.
 */
export async function recordMemoryErasure(
  db: Db,
  event: {
    orgId: string;
    kind: "erased" | "forgotten";
    scope: string;
    summary: unknown;
    operator?: string | null;
  },
): Promise<MemoryErasureEventRow> {
  return db.transaction(async (tx) => {
    if (event.kind === "erased") await lockOrgMemoryExclusive(tx, event.orgId);
    const [row] = await tx
      .insert(memoryErasureEvents)
      .values({ ...event, operator: event.operator ?? null })
      .returning();
    if (!row) throw new Error("memory erasure event was not written");
    return row;
  });
}

/** One org's erasure events, oldest first. */
export async function memoryErasureEventsFor(
  db: Exec,
  orgId: string,
): Promise<MemoryErasureEventRow[]> {
  return db
    .select()
    .from(memoryErasureEvents)
    .where(eq(memoryErasureEvents.orgId, orgId))
    .orderBy(asc(memoryErasureEvents.seq));
}
