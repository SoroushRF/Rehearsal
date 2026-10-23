import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { type Db, schema } from "../src";

/** A client tailing one run's feed: every event after its cursor, in seq order. */
export const eventsAfter = async (db: Db, runId: string, cursor: number) =>
  (
    await db
      .select()
      .from(schema.runEvents)
      .where(and(eq(schema.runEvents.runId, runId), gt(schema.runEvents.seq, cursor)))
      .orderBy(asc(schema.runEvents.seq))
  ).map((e) => ({ seq: e.seq, type: e.type }));

const until = async (check: () => Promise<boolean>, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
};

/**
 * Stall inserts of `type` events for `runId` by `seconds`, after their `seq` is taken (column
 * defaults run before BEFORE triggers) and before they commit. Only that run's rows are touched,
 * so other suites sharing the database are unaffected. `stalled()` resolves once an insert is
 * inside the stall: the trigger takes an advisory lock the test can see in `pg_locks`.
 */
export async function stallInsert(db: Db, runId: string, type: string, seconds: number) {
  const name = `stall_${randomUUID().replaceAll("-", "")}`;
  const key = Math.floor(Math.random() * 2 ** 31);
  await db.execute(
    sql.raw(`create function ${name}() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(7106, ${key}); perform pg_sleep(${seconds}); return new; end $$`),
  );
  await db.execute(
    sql.raw(`create trigger ${name} before insert on run_events for each row
      when (new.run_id = '${runId}' and new.type = '${type}') execute function ${name}()`),
  );
  return {
    stalled: () =>
      until(
        async () =>
          (
            await db.execute(
              sql`select 1 from pg_locks where locktype = 'advisory' and granted
                    and classid = 7106 and objid = ${key}`,
            )
          ).rows.length > 0,
      ),
    unstall: async () => {
      await db.execute(sql.raw(`drop trigger if exists ${name} on run_events`));
      await db.execute(sql.raw(`drop function if exists ${name}()`));
    },
  };
}

/** Some transaction is waiting for this run's event lock (the key `insertRunEvent` takes). */
export function waitingOnRunLock(db: Db, orgId: string, runId: string) {
  return db
    .execute(
      sql`select 1 from pg_locks where locktype = 'advisory' and not granted
            and ((classid::bigint << 32) | objid::bigint)
              = hashtextextended(${`rehearsal:run_events:${orgId}:${runId}`}, 0)`,
    )
    .then((r) => r.rows.length > 0);
}

/**
 * Writer A takes its `seq` first and commits late; writer B appends while A is in flight. Once B
 * has either committed (the bug) or is waiting on the run's lock (the fix), a reader polls, then
 * polls again from its cursor once both are done. It must have seen both events, and B must have
 * waited for A.
 */
export async function tailAcrossLateCommit(
  db: Db,
  orgId: string,
  runId: string,
  writeA: () => Promise<unknown>,
  aHasSeq: () => Promise<void>,
  writeB: () => Promise<unknown>,
) {
  const a = writeA();
  await aHasSeq();
  let bDone = false;
  const b = writeB().then(() => {
    bDone = true;
  });
  await until(async () => bDone || (await waitingOnRunLock(db, orgId, runId)));
  /** B queued behind A on the run's lock, rather than committing first. */
  const bWaited = !bDone;
  const seen = await eventsAfter(db, runId, 0);
  await Promise.all([a, b]);
  const rest = await eventsAfter(db, runId, seen.at(-1)?.seq ?? 0);
  return { types: [...seen, ...rest].map((e) => e.type).sort(), bWaited };
}
