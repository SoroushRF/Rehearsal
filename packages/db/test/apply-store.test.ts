import { randomUUID } from "node:crypto";
import { planHash } from "@rehearsal/core";
import { billingManifest } from "@rehearsal/testkit";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrateDb, PgApplyStore, schema } from "../src";

// Needs a real Postgres: `pnpm infra:up` then `DB_TESTS=1 pnpm --filter @rehearsal/db test`.
describe.skipIf(!process.env.DB_TESTS)("PgApplyStore (real Postgres)", () => {
  const url = process.env.DATABASE_URL ?? "postgres://rehearsal:rehearsal@localhost:5432/rehearsal";
  const db = createDb(url);
  const other = createDb(url); // a second pool: a different worker process
  beforeAll(() => migrateDb(db));
  afterAll(async () => {
    await db.$client.end();
    await other.$client.end();
  });

  async function seed() {
    const orgId = `org_${randomUUID()}`;
    const planId = `plan_${randomUUID()}`;
    const manifest = { ...billingManifest(planId), orgId };
    const hash = planHash(manifest);
    await db
      .insert(schema.planVersions)
      .values({ orgId, planId, revision: 1, planHash: hash, manifest });
    await db.insert(schema.approvalGrants).values({
      id: `grant_${randomUUID()}`,
      orgId,
      planId,
      revision: 1,
      planHash: hash,
      actorUserId: "u",
      actorSessionId: "s",
      roles: ["finance_lead"],
      grantedAt: new Date("2026-10-22T10:00:00.000Z"),
      expiresAt: new Date("2026-10-22T12:00:00.000Z"),
    });
    const [grant] = await db
      .select()
      .from(schema.approvalGrants)
      .where(eq(schema.approvalGrants.orgId, orgId));
    const runId = `run_${randomUUID()}`;
    await db.insert(schema.runs).values({
      id: runId,
      orgId,
      planId,
      revision: 1,
      planHash: hash,
      approvalId: grant?.id ?? "",
      requestedBy: "u",
      state: "approved",
    });
    return { orgId, planId, hash, runId, grantId: grant?.id ?? "", manifest };
  }

  it("loads the run, plan and grant, scoped to the org", async () => {
    const s = await seed();
    const store = new PgApplyStore(db);
    expect(await store.loadRun(s.orgId, s.runId)).toEqual({
      planId: s.planId,
      revision: 1,
      planHash: s.hash,
      approvalId: s.grantId,
    });
    expect((await store.loadPlan(s.orgId, s.planId, 1))?.planHash).toBe(s.hash);
    expect(await store.loadGrant(s.orgId, s.grantId)).toMatchObject({
      roles: ["finance_lead"],
      grantedAt: "2026-10-22T10:00:00.000Z",
      expiresAt: "2026-10-22T12:00:00.000Z",
      revokedAt: null,
    });
    expect(await store.loadRun("org_other", s.runId)).toBeNull();
    expect(await store.loadGrant("org_other", s.grantId)).toBeNull();
  });

  it("lists remedy steps for an obligation across plans of the org only", async () => {
    const s = await seed();
    const refund = s.manifest.actions.find((a) => a.kind === "stripe.refund.create");
    if (refund?.kind !== "stripe.refund.create") throw new Error("no refund in the fixture");
    // A second plan in the same org with the same obligation, and one in another org.
    const otherPlan = { ...s.manifest, planId: `plan_${randomUUID()}` };
    const elsewhere = { ...s.manifest, orgId: `org_${randomUUID()}` };
    for (const m of [otherPlan, elsewhere]) {
      await db.insert(schema.planVersions).values({
        orgId: m.orgId,
        planId: m.planId,
        revision: 1,
        planHash: planHash(m),
        manifest: m,
      });
    }
    const steps = await new PgApplyStore(db).remedyStepsFor(s.orgId, refund.obligationId);
    expect(steps).toEqual(
      expect.arrayContaining([
        { planHash: s.hash, actionId: refund.id },
        { planHash: planHash(otherPlan), actionId: refund.id },
      ]),
    );
    expect(steps).toHaveLength(2);
    expect(await new PgApplyStore(db).remedyStepsFor(s.orgId, "obl_none")).toEqual([]);
  });

  it("the plan lock is exclusive across processes, per plan, and released on release()", async () => {
    const s = await seed();
    const a = new PgApplyStore(db);
    const b = new PgApplyStore(other);
    const release = await a.lockPlan(s.orgId, s.planId);
    expect(release).not.toBeNull();
    expect(await b.lockPlan(s.orgId, s.planId)).toBeNull();
    const otherPlan = await b.lockPlan(s.orgId, `${s.planId}_x`);
    expect(otherPlan).not.toBeNull();
    await otherPlan?.();

    await release?.();
    await release?.(); // idempotent
    const again = await b.lockPlan(s.orgId, s.planId);
    expect(again).not.toBeNull();
    await again?.();
  });

  it("drops the lock when the holding connection dies", async () => {
    const s = await seed();
    const dying = createDb(url);
    dying.$client.on("error", () => {}); // the terminated backend surfaces as a pool error
    expect(await new PgApplyStore(dying).lockPlan(s.orgId, s.planId)).not.toBeNull();
    // The worker process dies: Postgres terminates its backend, and the session lock goes with it.
    const key = `rehearsal:apply:${s.orgId}:${s.planId}`;
    // The timeout form waits until the backend has actually exited (and dropped its locks);
    // without it the next lock attempt could race the dying session.
    const killed = await other.$client.query(
      `select pg_terminate_backend(pid, 5000) as ok from pg_locks
        where locktype = 'advisory' and granted
          and ((classid::bigint << 32) | objid::bigint)::bit(64) = hashtextextended($1, 0)::bit(64)`,
      [key],
    );
    expect(killed.rows).toEqual([{ ok: true }]);
    const next = await new PgApplyStore(other).lockPlan(s.orgId, s.planId);
    expect(next).not.toBeNull();
    await next?.();
  });

  it("doesn't pile up error listeners on pooled connections", async () => {
    const s = await seed();
    const warnings: string[] = [];
    const onWarning = (w: Error) => warnings.push(w.name);
    process.on("warning", onWarning);
    try {
      const store = new PgApplyStore(db);
      for (let i = 0; i < 15; i++) {
        const release = await store.lockPlan(s.orgId, s.planId);
        await release?.();
      }
      const client = await db.$client.connect();
      expect(client.listenerCount("error")).toBeLessThanOrEqual(1);
      client.release();
    } finally {
      process.off("warning", onWarning);
    }
    expect(warnings).not.toContain("MaxListenersExceededWarning");
  });

  it("moves a run's state only from the expected states", async () => {
    const s = await seed();
    const store = new PgApplyStore(db);
    expect(await store.transitionRun(s.orgId, s.runId, ["approved"], "applying")).toBe(true);
    expect(await store.transitionRun(s.orgId, s.runId, ["approved"], "applying")).toBe(false);
    expect(await store.transitionRun("org_other", s.runId, ["applying"], "completed")).toBe(false);
    expect(await store.runState(s.orgId, s.runId)).toBe("applying");
  });

  it("updates only the run's state", async () => {
    const s = await seed();
    await new PgApplyStore(db).setRunState(s.orgId, s.runId, "partial");
    const [row] = await db.select().from(schema.runs).where(eq(schema.runs.id, s.runId));
    expect(row?.state).toBe("partial");
  });
});
