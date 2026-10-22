import { planHash } from "@rehearsal/core";
import {
  APPLY_QUEUE,
  ApplyJob,
  createDb,
  migrateDb,
  type PgBoss,
  schema,
  startQueue,
} from "@rehearsal/db";
import { billingManifest } from "@rehearsal/testkit";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { type AuthContext, noAuth } from "../src/apply";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const HOUR = 3_600_000;

// Needs a real Postgres: `pnpm infra:up` then `DB_TESTS=1 pnpm --filter @rehearsal/api test`.
describe.skipIf(!process.env.DB_TESTS)("POST /api/plans/:id/apply (real Postgres)", () => {
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

  /** A fresh org with one stored revision and, unless told otherwise, a live grant for it. */
  async function seed(grant: Partial<typeof schema.approvalGrants.$inferInsert> | null = {}) {
    const orgId = `org_${crypto.randomUUID()}`;
    const planId = `plan_${crypto.randomUUID()}`;
    const manifest = { ...billingManifest(planId), orgId };
    const hash = planHash(manifest);
    await db
      .insert(schema.planVersions)
      .values({ orgId, planId, revision: 1, planHash: hash, manifest });
    if (grant) {
      await db.insert(schema.approvalGrants).values({
        id: `grant_${crypto.randomUUID()}`,
        orgId,
        planId,
        revision: 1,
        planHash: hash,
        actorUserId: "user_finance",
        actorSessionId: "sess_1",
        roles: ["finance_lead"],
        grantedAt: new Date(NOW.getTime() - HOUR),
        expiresAt: new Date(NOW.getTime() + HOUR),
        ...grant,
      });
    }
    return { orgId, planId, hash };
  }

  function appFor(auth: AuthContext | null) {
    return buildApp({ apply: { db, boss, auth: () => auth, now: () => NOW } });
  }

  async function apply(auth: AuthContext | null, planId: string, body: unknown) {
    const app = appFor(auth);
    const res = await app.inject({
      method: "POST",
      url: `/api/plans/${planId}/apply`,
      payload: body as object,
    });
    await app.close();
    return res;
  }

  it("refuses an unauthenticated request (the default until Clerk lands)", async () => {
    const { planId, hash } = await seed();
    const app = buildApp({ apply: { db, boss, auth: noAuth } });
    const res = await app.inject({
      method: "POST",
      url: `/api/plans/${planId}/apply`,
      payload: { revision: 1, planHash: hash },
    });
    await app.close();
    expect(res.statusCode).toBe(401);
  });

  /** Jobs in pg-boss's own table for one plan hash (queried directly, not via a shared fetch). */
  async function jobsFor(hash: string) {
    const res = await db.execute(
      sql`select data from pgboss.job where name = ${APPLY_QUEUE} and data->>'planHash' = ${hash}`,
    );
    return res.rows.map((r) => ApplyJob.parse((r as { data: unknown }).data));
  }

  it("refuses a malformed body", async () => {
    const { orgId, planId } = await seed();
    const res = await apply({ orgId, userId: "u" }, planId, { revision: "one" });
    expect(res.statusCode).toBe(400);
  });

  it("refuses action bodies from the browser even alongside a valid revision and hash", async () => {
    const { orgId, planId, hash } = await seed();
    const res = await apply({ orgId, userId: "u" }, planId, {
      revision: 1,
      planHash: hash,
      actions: [],
    });
    expect(res.statusCode).toBe(400);
    expect(await jobsFor(hash)).toEqual([]);
  });

  it("returns 404 for an unknown plan", async () => {
    const { orgId } = await seed();
    const res = await apply({ orgId, userId: "u" }, "plan_missing", {
      revision: 1,
      planHash: "a".repeat(64),
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for another org's plan", async () => {
    const { planId, hash } = await seed();
    const res = await apply({ orgId: "org_other", userId: "u" }, planId, {
      revision: 1,
      planHash: hash,
    });
    expect(res.statusCode).toBe(404);
  });

  it("refuses a changed hash", async () => {
    const { orgId, planId } = await seed();
    const res = await apply({ orgId, userId: "u" }, planId, {
      revision: 1,
      planHash: "f".repeat(64),
    });
    expect(res.statusCode).toBe(409);
  });

  it.each([
    ["no grant", null],
    ["an expired grant", { expiresAt: new Date(NOW.getTime() - 1) }],
    ["a revoked grant", { revokedAt: new Date(NOW.getTime() - 1) }],
    ["a grant dated in the future", { grantedAt: new Date(NOW.getTime() + 1) }],
  ])("refuses %s and enqueues nothing", async (_label, grant) => {
    const { orgId, planId, hash } = await seed(grant);
    const res = await apply({ orgId, userId: "u" }, planId, { revision: 1, planHash: hash });
    expect(res.statusCode).toBe(403);
    const rows = await db.select().from(schema.runs).where(eq(schema.runs.planId, planId));
    expect(rows).toEqual([]);
    expect(await jobsFor(hash)).toEqual([]);
  });

  it("accepts a live grant, creates one run and enqueues one valid job", async () => {
    const { orgId, planId, hash } = await seed();
    const first = await apply({ orgId, userId: "u" }, planId, { revision: 1, planHash: hash });
    expect(first.statusCode).toBe(202);
    const { runId, existing, state } = first.json();
    expect({ existing, state }).toEqual({ existing: false, state: "approved" });

    const again = await apply({ orgId, userId: "u" }, planId, { revision: 1, planHash: hash });
    expect(again.json()).toEqual({ runId, state: "approved", existing: true });

    expect(await jobsFor(hash)).toEqual([{ orgId, runId, planId, revision: 1, planHash: hash }]);
    const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    expect(run?.requestedBy).toBe("u");
  });

  it("creates exactly one run under concurrent requests", async () => {
    const { orgId, planId, hash } = await seed();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        apply({ orgId, userId: "u" }, planId, { revision: 1, planHash: hash }),
      ),
    );
    const runIds = new Set(results.map((r) => r.json().runId));
    expect(runIds.size).toBe(1);
    expect(results.filter((r) => r.json().existing === false)).toHaveLength(1);
    expect(await jobsFor(hash)).toHaveLength(1);
  });

  it("starts a new run after a held run, so the plan can be resumed", async () => {
    const { orgId, planId, hash } = await seed();
    const first = (
      await apply({ orgId, userId: "u" }, planId, { revision: 1, planHash: hash })
    ).json();
    await db.update(schema.runs).set({ state: "held" }).where(eq(schema.runs.id, first.runId));

    const second = await apply({ orgId, userId: "u" }, planId, { revision: 1, planHash: hash });
    expect(second.statusCode).toBe(202);
    expect(second.json().runId).not.toBe(first.runId);
    expect(await jobsFor(hash)).toHaveLength(2);
  });

  it("returns a cancelled run instead of restarting it", async () => {
    const { orgId, planId, hash } = await seed();
    const first = (
      await apply({ orgId, userId: "u" }, planId, { revision: 1, planHash: hash })
    ).json();
    await db.update(schema.runs).set({ state: "cancelled" }).where(eq(schema.runs.id, first.runId));
    const again = await apply({ orgId, userId: "u" }, planId, { revision: 1, planHash: hash });
    expect(again.json()).toEqual({ runId: first.runId, state: "cancelled", existing: true });
    expect(await jobsFor(hash)).toHaveLength(1);
  });

  it("returns a completed run instead of starting another", async () => {
    const { orgId, planId, hash } = await seed();
    const first = (
      await apply({ orgId, userId: "u" }, planId, { revision: 1, planHash: hash })
    ).json();
    await db.update(schema.runs).set({ state: "completed" }).where(eq(schema.runs.id, first.runId));
    const again = await apply({ orgId, userId: "u" }, planId, { revision: 1, planHash: hash });
    expect(again.json()).toEqual({ runId: first.runId, state: "completed", existing: true });
  });
});
