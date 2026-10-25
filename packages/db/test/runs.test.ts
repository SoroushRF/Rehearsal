import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APPLY_QUEUE,
  createDb,
  MAX_REAPS,
  migrateDb,
  type PgBoss,
  reapStuckRuns,
  requestCancel,
  schema,
  startQueue,
} from "../src";
import { insertRunEvent } from "../src/events";
import { waitingOnRunLock } from "./events-helpers";

// Needs a real Postgres: `pnpm infra:up` then `DB_TESTS=1 pnpm --filter @rehearsal/db test`.
describe.skipIf(!process.env.DB_TESTS)("run commands: cancel and reaper (real Postgres)", () => {
  const url = process.env.DATABASE_URL ?? "postgres://rehearsal:rehearsal@localhost:5432/rehearsal";
  const db = createDb(url);
  let boss: PgBoss;
  beforeAll(async () => {
    await migrateDb(db);
    boss = await startQueue(url);
  });
  afterAll(async () => {
    await boss?.stop({ graceful: false });
    await db.$client.end();
  });

  /**
   * Sweep only these runs and wait for the reaper lock: other files share this database and sweep
   * too, and must neither reap these runs nor make a pass skip (#243).
   */
  const mine = (...runs: { id: string }[]) => ({
    runIds: runs.map((r) => r.id),
    waitForLock: true,
  });

  async function run(state: string, updatedAt = new Date()) {
    const orgId = `org_${randomUUID()}`;
    const id = `run_${randomUUID()}`;
    await db.insert(schema.runs).values({
      id,
      orgId,
      planId: `plan_${randomUUID()}`,
      revision: 1,
      planHash: `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`.slice(
        0,
        64,
      ),
      approvalId: "g",
      requestedBy: "u",
      state,
      updatedAt,
    });
    return { orgId, id };
  }
  const stateOf = async (id: string) =>
    (await db.select().from(schema.runs).where(eq(schema.runs.id, id)))[0]?.state;
  /** Jobs ever enqueued for a run, in any state: another suite's worker may drain the shared queue. */
  const jobsFor = async (runId: string) =>
    (
      await db.execute(
        sql`select 1 from pgboss.job where name = ${APPLY_QUEUE} and data->>'runId' = ${runId}`,
      )
    ).rows.length;

  it("cancels only an approved or applying run, in its own org", async () => {
    const applying = await run("applying");
    expect(await requestCancel(db, { orgId: "org_other", runId: applying.id })).toEqual({
      kind: "not_found",
    });
    expect(await requestCancel(db, { orgId: applying.orgId, runId: applying.id })).toEqual({
      kind: "cancelled",
      runId: applying.id,
    });
    expect(await stateOf(applying.id)).toBe("cancelled");

    const done = await run("completed");
    expect(await requestCancel(db, { orgId: done.orgId, runId: done.id })).toEqual({
      kind: "not_active",
      state: "completed",
    });
  });

  it("writes the reaper's events under the run's event lock (#106)", async () => {
    const stuck = await run("applying", new Date(Date.now() - 3_600_000));
    // Another writer of this run is mid-transaction, holding the run's event lock.
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let locked = () => {};
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    const other = db.transaction(async (tx) => {
      await insertRunEvent(tx as unknown as typeof db, {
        orgId: stuck.orgId,
        runId: stuck.id,
        type: "b",
        payload: {},
      });
      locked();
      await held;
    });
    await isLocked;
    let done = false;
    const sweep = reapStuckRuns(db, boss, {
      now: new Date(),
      staleAfterMs: 10 * 60_000,
      ...mine(stuck),
    }).then((ids) => {
      done = true;
      return ids;
    });
    // The sweep must queue behind that writer instead of taking a seq that commits out of order.
    const deadline = Date.now() + 5_000;
    while (!done && !(await waitingOnRunLock(db, stuck.orgId, stuck.id)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const waited = !done;
    release();
    await other;
    expect(waited).toBe(true);
    expect(await sweep).toContain(stuck.id);
  });

  it("re-enqueues a stale run with no live job, and only that one", async () => {
    const old = new Date(Date.now() - 3_600_000);
    const stuck = await run("applying", old);
    const fresh = await run("applying");
    const finished = await run("partial", old);
    const cancelled = await run("cancelled", old);
    const now = new Date();
    const four = mine(stuck, fresh, finished, cancelled);
    const reaped = await reapStuckRuns(db, boss, { now, staleAfterMs: 10 * 60_000, ...four });
    expect(reaped).toContain(stuck.id);
    for (const other of [fresh, finished, cancelled]) expect(reaped).not.toContain(other.id);
    expect(await jobsFor(stuck.id)).toBe(1);

    // Its timestamp was touched: a sweep within the stale window leaves it alone.
    const again = await reapStuckRuns(db, boss, {
      now: new Date(now.getTime() + 60_000),
      staleAfterMs: 10 * 60_000,
      ...four,
    });
    expect(again).not.toContain(stuck.id);
    expect(await jobsFor(stuck.id)).toBe(1);
  });

  it("re-enqueues a stale cancelled run only while it has a send in flight", async () => {
    const old = new Date(Date.now() - 3_600_000);
    const withSend = await run("cancelled", old);
    const [row] = await db.select().from(schema.runs).where(eq(schema.runs.id, withSend.id));
    const sendId = `att_${randomUUID()}`;
    await db.insert(schema.stepAttempts).values({
      id: sendId,
      orgId: withSend.orgId,
      planHash: row?.planHash ?? "",
      actionId: "refund_001",
      operationKey: `op_${randomUUID()}`,
      attemptNo: 1,
      state: "dispatched",
      request: {
        method: "POST",
        path: "/v1/refunds",
        encoding: "form",
        body: "",
        bodySha256: "0".repeat(64),
      },
      preparedAt: old,
      dispatchedAt: old,
    });
    const quiet = await run("cancelled", old);
    const reaped = await reapStuckRuns(db, boss, {
      now: new Date(),
      staleAfterMs: 60_000,
      ...mine(withSend, quiet),
    });
    expect(reaped).toContain(withSend.id);
    expect(reaped).not.toContain(quiet.id);

    // Every pass's job ends without resolving the send: the reaper retries up to the cap, then
    // hands the run to an operator once and stops.
    const drain = () =>
      db.execute(
        sql`update pgboss.job set state = 'completed' where name = ${APPLY_QUEUE} and data->>'runId' = ${withSend.id}`,
      );
    await drain();
    let reaps = 1;
    for (let i = 1; i <= MAX_REAPS + 2; i++) {
      const later = new Date(Date.now() + i * 3_600_000);
      if (
        (
          await reapStuckRuns(db, boss, { now: later, staleAfterMs: 60_000, ...mine(withSend) })
        ).includes(withSend.id)
      ) {
        reaps += 1;
      }
      await drain();
    }
    expect(reaps).toBe(MAX_REAPS);
    const handOffs = await db.execute(
      sql`select 1 from run_events where run_id = ${withSend.id} and type = 'run.needs_operator'`,
    );
    expect(handOffs.rows).toHaveLength(1);
  });

  it("an applying run whose worker keeps dying is capped, handed off once, and freed to re-apply", async () => {
    const stuck = await run("applying", new Date(Date.now() - 3_600_000));
    const handed: string[] = [];
    const drain = () =>
      db.execute(
        sql`update pgboss.job set state = 'failed' where name = ${APPLY_QUEUE} and data->>'runId' = ${stuck.id}`,
      );
    let reaps = 0;
    for (let i = 0; i <= MAX_REAPS + 1; i++) {
      const later = new Date(Date.now() + i * 3_600_000);
      const swept = await reapStuckRuns(db, boss, {
        now: later,
        staleAfterMs: 60_000,
        ...mine(stuck),
        onHandOff: (ids) => handed.push(...ids.filter((id) => id === stuck.id)),
      });
      if (swept.includes(stuck.id)) {
        reaps += 1;
      }
      await drain();
    }
    expect(reaps).toBe(MAX_REAPS);
    const handOffs = await db.execute(
      sql`select 1 from run_events where run_id = ${stuck.id} and type = 'run.needs_operator'`,
    );
    expect(handOffs.rows).toHaveLength(1);
    expect(handed).toEqual([stuck.id]);
    // Marked failed, so re-applying its hash starts a new run instead of returning this dead one.
    expect(await stateOf(stuck.id)).toBe("failed");
  });

  it("no hand-off for a cancelled run whose last reconcile resolved its send", async () => {
    const old = new Date(Date.now() - 3_600_000);
    const r = await run("cancelled", old);
    const [row] = await db.select().from(schema.runs).where(eq(schema.runs.id, r.id));
    const attemptId = `att_${randomUUID()}`;
    await db.insert(schema.stepAttempts).values({
      id: attemptId,
      orgId: r.orgId,
      planHash: row?.planHash ?? "",
      actionId: "refund_001",
      operationKey: `op_${randomUUID()}`,
      attemptNo: 1,
      state: "dispatched",
      request: {
        method: "POST",
        path: "/v1/refunds",
        encoding: "form",
        body: "",
        bodySha256: "0".repeat(64),
      },
      preparedAt: old,
      dispatchedAt: old,
    });
    const drain = () =>
      db.execute(
        sql`update pgboss.job set state = 'completed' where name = ${APPLY_QUEUE} and data->>'runId' = ${r.id}`,
      );
    for (let i = 1; i <= MAX_REAPS; i++) {
      await reapStuckRuns(db, boss, {
        now: new Date(Date.now() + i * 3_600_000),
        staleAfterMs: 60_000,
        ...mine(r),
      });
      await drain();
    }
    // The last pass found the refund: the send is reconciled.
    await db
      .update(schema.stepAttempts)
      .set({ state: "reconciled" })
      .where(eq(schema.stepAttempts.id, attemptId));
    await reapStuckRuns(db, boss, {
      now: new Date(Date.now() + (MAX_REAPS + 2) * 3_600_000),
      staleAfterMs: 60_000,
      ...mine(r),
    });
    const handOffs = await db.execute(
      sql`select 1 from run_events where run_id = ${r.id} and type = 'run.needs_operator'`,
    );
    expect(handOffs.rows).toHaveLength(0);
  });

  it("concurrent reapers enqueue a stuck run once", async () => {
    const stuck = await run("approved", new Date(Date.now() - 3_600_000));
    const now = new Date();
    const results = await Promise.all(
      // No waitForLock here: this checks the production skip-if-busy behaviour.
      Array.from({ length: 4 }, () =>
        reapStuckRuns(db, boss, { now, staleAfterMs: 60_000, runIds: [stuck.id] }),
      ),
    );
    expect(results.filter((r) => r.includes(stuck.id))).toHaveLength(1);
    expect(await jobsFor(stuck.id)).toBe(1);
  });
});
