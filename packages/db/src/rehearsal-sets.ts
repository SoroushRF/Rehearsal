import { and, eq, isNull, ne } from "drizzle-orm";
import type { Db } from "./index";
import { rehearsalDirtyMarks } from "./schema";

/**
 * T3.16: one rehearsal container set at a time per challenge (decision 0013 §3).
 *
 * - The set's lock is a Postgres session advisory lock, held for the whole run on its own pooled
 *   connection. An unchallenged rehearsal takes it shared; a challenged one takes it exclusive, so
 *   a challenge never runs next to another rehearsal on the same containers.
 * - Postgres drops the lock when that connection dies, so the lock alone can't fence a crashed
 *   challenged run. Before its first inject it writes a dirty mark; only confirmed cleanup clears
 *   it. While a set has an uncleared mark, admission refuses every rehearsal on it.
 */

/** The default set: one compose profile of rehearsal containers. */
export const DEFAULT_CONTAINER_SET = "rehearsal";

const lockKey = (set: string) => `rehearsal:container-set:${set}`;

export type ContainerSetLock = { release: () => Promise<void> } | null;

/**
 * Wait up to `waitMs` for the set's lock. Null when it stays busy. A shared holder doesn't block
 * another shared one; an exclusive holder blocks everyone, and waits for every shared holder.
 */
export async function holdContainerSet(
  db: Db,
  set: string,
  mode: "shared" | "exclusive",
  opts: { waitMs: number; pollMs?: number } = { waitMs: 0 },
): Promise<ContainerSetLock> {
  const client = await db.$client.connect();
  const fn = mode === "shared" ? "pg_try_advisory_lock_shared" : "pg_try_advisory_lock";
  const deadline = Date.now() + opts.waitMs;
  try {
    for (;;) {
      const { rows } = await client.query<{ ok: boolean }>(
        `select ${fn}(hashtextextended($1, 0)) as ok`,
        [lockKey(set)],
      );
      if (rows[0]?.ok) break;
      if (Date.now() >= deadline) {
        client.release();
        return null;
      }
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 250));
    }
  } catch (err) {
    client.release(true);
    throw err;
  }
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      const unlock = mode === "shared" ? "pg_advisory_unlock_shared" : "pg_advisory_unlock";
      try {
        await client.query(`select ${unlock}(hashtextextended($1, 0))`, [lockKey(set)]);
        client.release();
      } catch {
        client.release(true); // a dead connection drops the lock with it
      }
    },
  };
}

/** Another rehearsal's uncleared mark on this set, if any. */
export async function dirtyMarkOn(
  db: Db,
  set: string,
  except?: string,
): Promise<{ rehearsalId: string; markedAt: Date } | null> {
  const [row] = await db
    .select({
      rehearsalId: rehearsalDirtyMarks.rehearsalId,
      markedAt: rehearsalDirtyMarks.markedAt,
    })
    .from(rehearsalDirtyMarks)
    .where(
      and(
        eq(rehearsalDirtyMarks.containerSet, set),
        isNull(rehearsalDirtyMarks.clearedAt),
        ...(except ? [ne(rehearsalDirtyMarks.rehearsalId, except)] : []),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Mark the set dirty for this rehearsal, before its first inject. Once per rehearsal. */
export async function markContainerSetDirty(
  db: Db,
  input: { set: string; orgId: string; rehearsalId: string; now: Date },
): Promise<void> {
  await db
    .insert(rehearsalDirtyMarks)
    .values({
      containerSet: input.set,
      orgId: input.orgId,
      rehearsalId: input.rehearsalId,
      markedAt: input.now,
      clearedAt: null,
      clearedBy: null,
    })
    .onConflictDoNothing({ target: rehearsalDirtyMarks.rehearsalId });
}

/**
 * Clear this rehearsal's mark once its cleanup is confirmed. `by` says what confirmed it. Returns
 * false when there was no uncleared mark.
 */
export async function clearContainerSetDirty(
  db: Db,
  rehearsalId: string,
  by: string,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(rehearsalDirtyMarks)
    .set({ clearedAt: now, clearedBy: by })
    .where(
      and(eq(rehearsalDirtyMarks.rehearsalId, rehearsalId), isNull(rehearsalDirtyMarks.clearedAt)),
    )
    .returning({ id: rehearsalDirtyMarks.id });
  return rows.length > 0;
}

/** Whether this rehearsal has written its mark and it isn't cleared yet. */
export async function rehearsalMarkedDirty(db: Db, rehearsalId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: rehearsalDirtyMarks.id })
    .from(rehearsalDirtyMarks)
    .where(
      and(eq(rehearsalDirtyMarks.rehearsalId, rehearsalId), isNull(rehearsalDirtyMarks.clearedAt)),
    )
    .limit(1);
  return !!row;
}
