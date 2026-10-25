import { randomUUID } from "node:crypto";
import { createDb, migrateDb, type PgBoss, schema, startQueue } from "@rehearsal/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { bearer, type Caller, fakeIam, support } from "./fake-iam";

describe("POST /api/runs/:id/cancel without a database", () => {
  it("answers 503, not 404", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "POST", url: "/api/runs/r/cancel" });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

// Needs a real Postgres: `pnpm infra:up` then `DB_TESTS=1 pnpm --filter @rehearsal/api test`.
describe.skipIf(!process.env.DB_TESTS)("POST /api/runs/:id/cancel (real Postgres)", () => {
  const url = process.env.DATABASE_URL ?? "postgres://rehearsal:rehearsal@localhost:5432/rehearsal";
  const db = createDb(url);
  let boss: PgBoss;
  beforeAll(async () => {
    await migrateDb(db);
    boss = await startQueue(url);
  });
  afterAll(async () => {
    await boss?.stop({ graceful: false });
  });

  async function run(state: string) {
    const orgId = `org_${randomUUID()}`;
    const id = `run_${randomUUID()}`;
    await db.insert(schema.runs).values({
      id,
      orgId,
      planId: "p",
      revision: 1,
      planHash: randomUUID().replaceAll("-", "").repeat(2),
      approvalId: "g",
      requestedBy: "u",
      state,
    });
    return { orgId, id };
  }
  async function cancel(person: Caller | null, runId: string) {
    const app = buildApp({
      apply: { db, boss, iam: fakeIam(person ? [person] : []) },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/cancel`,
      headers: person ? bearer(person) : {},
    });
    await app.close();
    return res;
  }

  it("refuses an unauthenticated request", async () => {
    const r = await run("applying");
    const app = buildApp({ apply: { db, boss, iam: fakeIam([]) } });
    const res = await app.inject({ method: "POST", url: `/api/runs/${r.id}/cancel` });
    await app.close();
    expect(res.statusCode).toBe(401);
  });

  it("cancels an applying run (202), refuses a finished one (409) and another org's (404)", async () => {
    const r = await run("applying");
    expect((await cancel(support("org_other"), r.id)).statusCode).toBe(404);
    const ok = await cancel(support(r.orgId), r.id);
    expect(ok.statusCode).toBe(202);
    expect(ok.json()).toEqual({ runId: r.id, state: "cancelled" });
    const [row] = await db.select().from(schema.runs).where(eq(schema.runs.id, r.id));
    expect(row?.state).toBe("cancelled");

    const done = await run("completed");
    const conflict = await cancel(support(done.orgId), done.id);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: "run_not_active", state: "completed" });
  });
});
