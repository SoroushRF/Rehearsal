import { createDb, type Db, migrateDb, schema } from "@rehearsal/db";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import type { AuthContext } from "../src/apply";

async function get(deps: Parameters<typeof buildApp>[0], url: string) {
  const app = buildApp({ webRoot: null, ...deps });
  try {
    return await app.inject({ method: "GET", url });
  } finally {
    await app.close();
  }
}

describe("run routes before touching the database", () => {
  it("are unavailable without a database", async () => {
    expect((await get({}, "/api/runs/r1/events")).statusCode).toBe(503);
    expect((await get({}, "/api/plans/p1/runs")).statusCode).toBe(503);
  });

  it("refuse a caller who isn't signed in", async () => {
    const deps = { runs: { db: {} as Db, auth: () => null } };
    expect((await get(deps, "/api/runs/r1/events")).statusCode).toBe(401);
    expect((await get(deps, "/api/plans/p1/runs")).statusCode).toBe(401);
  });

  it("refuses a malformed cursor", async () => {
    const deps = { runs: { db: {} as Db, auth: () => ({ orgId: "o", userId: "u" }) } };
    expect((await get(deps, "/api/runs/r1/events?after=-1")).statusCode).toBe(400);
  });
});

// Needs a real Postgres: `pnpm infra:up` then `DB_TESTS=1 pnpm --filter @rehearsal/api test`.
describe.skipIf(!process.env.DB_TESTS)("run routes (real Postgres)", () => {
  const url = process.env.DATABASE_URL ?? "postgres://rehearsal:rehearsal@localhost:5432/rehearsal";
  const db = createDb(url);
  beforeAll(() => migrateDb(db));
  const deps = (auth: AuthContext) => ({ runs: { db, auth: () => auth } });

  /** A held run with three events, as the executor would write them. */
  async function seed() {
    const orgId = `org_${crypto.randomUUID()}`;
    const planId = `plan_${crypto.randomUUID()}`;
    const runId = `run_${crypto.randomUUID()}`;
    await db.insert(schema.runs).values({
      id: runId,
      orgId,
      planId,
      revision: 1,
      planHash: "a".repeat(64),
      approvalId: "grant_1",
      requestedBy: "user_1",
      state: "held",
    });
    const events = await db
      .insert(schema.runEvents)
      .values([
        { orgId, runId, type: "run.admitted", payload: { approvalId: "grant_1" } },
        { orgId, runId, type: "step.receipt", payload: { actionId: "refund_001" } },
        { orgId, runId, type: "run.finished", payload: { state: "held", error: null } },
      ])
      .returning({ seq: schema.runEvents.seq });
    return { orgId, planId, runId, seqs: events.map((e) => e.seq), user: { orgId, userId: "u" } };
  }

  it("returns the run and its events in order", async () => {
    const { runId, planId, seqs, user } = await seed();
    const res = await get(deps(user), `/api/runs/${runId}/events`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.run).toMatchObject({ id: runId, planId, state: "held", approvalId: "grant_1" });
    expect(body.events.map((e: { type: string }) => e.type)).toEqual([
      "run.admitted",
      "step.receipt",
      "run.finished",
    ]);
    expect(body.events.map((e: { seq: number }) => e.seq)).toEqual(seqs);
    expect(body.more).toBe(false);
  });

  it("returns only events after the cursor", async () => {
    const { runId, seqs, user } = await seed();
    const body = (await get(deps(user), `/api/runs/${runId}/events?after=${seqs[1]}`)).json();
    expect(body.events.map((e: { type: string }) => e.type)).toEqual(["run.finished"]);
  });

  it("hides another org's run", async () => {
    const { runId, planId } = await seed();
    const other = { orgId: "org_other", userId: "u" };
    expect((await get(deps(other), `/api/runs/${runId}/events`)).statusCode).toBe(404);
    expect((await get(deps(other), `/api/plans/${planId}/runs`)).json()).toEqual({ runs: [] });
  });

  it("lists a plan's runs", async () => {
    const { runId, planId, user } = await seed();
    const body = (await get(deps(user), `/api/plans/${planId}/runs`)).json();
    expect(body.runs.map((r: { id: string }) => r.id)).toEqual([runId]);
  });
});
