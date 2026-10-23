import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APPLY_QUEUE,
  createDb,
  migrateDb,
  type PgBoss,
  reapStuckRuns,
  requestCancel,
  schema,
  startQueue,
} from "../src";

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

  it("re-enqueues a stale run with no live job, and only that one", async () => {
    const old = new Date(Date.now() - 3_600_000);
    const stuck = await run("applying", old);
    const fresh = await run("applying");
    const finished = await run("partial", old);
    const cancelled = await run("cancelled", old);
    const now = new Date();
    const reaped = await reapStuckRuns(db, boss, { now, staleAfterMs: 10 * 60_000 });
    expect(reaped).toContain(stuck.id);
    for (const other of [fresh, finished, cancelled]) expect(reaped).not.toContain(other.id);
    expect(await jobsFor(stuck.id)).toBe(1);

    // Its timestamp was touched: a sweep within the stale window leaves it alone.
    const again = await reapStuckRuns(db, boss, {
      now: new Date(now.getTime() + 60_000),
      staleAfterMs: 10 * 60_000,
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
    const reaped = await reapStuckRuns(db, boss, { now: new Date(), staleAfterMs: 60_000 });
    expect(reaped).toContain(withSend.id);
    expect(reaped).not.toContain(quiet.id);

    // Its job runs and finishes without resolving the send (the read stays inconclusive)...
    await db.execute(
      sql`update pgboss.job set state = 'completed' where name = ${APPLY_QUEUE} and data->>'runId' = ${withSend.id}`,
    );
    // ...it leaves a held receipt naming the attempt. Within the day the reaper tries again;
    // after a day it stops (an operator takes over).
    await db.insert(schema.stepReceipts).values({
      id: `rcp_${randomUUID()}`,
      orgId: withSend.orgId,
      planHash: row?.planHash ?? "",
      actionId: "refund_001",
      receipt: { outcome: "held", holdReason: { kind: "unresolved_outcome", attemptId: sendId } },
      recordedAt: new Date(),
    });
    const soon = await reapStuckRuns(db, boss, {
      now: new Date(Date.now() + 3_600_000),
      staleAfterMs: 60_000,
    });
    expect(soon).toContain(withSend.id);
    await db.execute(
      sql`update pgboss.job set state = 'completed' where name = ${APPLY_QUEUE} and data->>'runId' = ${withSend.id}`,
    );
    const muchLater = await reapStuckRuns(db, boss, {
      now: new Date(Date.now() + 2 * 24 * 3_600_000),
      staleAfterMs: 60_000,
    });
    expect(muchLater).not.toContain(withSend.id);
  });

  it("past a day, keeps re-trying a cancelled run's in-flight send until some receipt names it", async () => {
    const old = new Date(Date.now() - 3 * 24 * 3_600_000);
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
      dispatchedAt: old, // the worker died three days ago, before any pass recorded anything
    });
    const sweep = () =>
      reapStuckRuns(db, boss, { now: new Date(Date.now() + 3_600_000), staleAfterMs: 60_000 });
    const drain = () =>
      db.execute(
        sql`update pgboss.job set state = 'completed' where name = ${APPLY_QUEUE} and data->>'runId' = ${r.id}`,
      );
    expect(await sweep()).toContain(r.id); // no receipt yet: still owed a reconcile
    await drain();

    await db.insert(schema.stepReceipts).values({
      id: `rcp_${randomUUID()}`,
      orgId: r.orgId,
      planHash: row?.planHash ?? "",
      actionId: "refund_001",
      receipt: { outcome: "held", holdReason: { kind: "unresolved_outcome", attemptId } },
      recordedAt: new Date(),
    });
    expect(await sweep()).not.toContain(r.id); // recorded as held: an operator takes it from here
  });

  it("concurrent reapers enqueue a stuck run once", async () => {
    const stuck = await run("approved", new Date(Date.now() - 3_600_000));
    const now = new Date();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => reapStuckRuns(db, boss, { now, staleAfterMs: 60_000 })),
    );
    expect(results.filter((r) => r.includes(stuck.id))).toHaveLength(1);
    expect(await jobsFor(stuck.id)).toBe(1);
  });
});
