import { PlanManifest } from "@rehearsal/contracts";
import type { BillingPolicyV1 } from "@rehearsal/core";
import { createDb, type Db, migrateDb, schema } from "@rehearsal/db";
import { billingManifest } from "@rehearsal/testkit";
import { beforeAll, describe, expect, it } from "vitest";
import policyJson from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import { buildApp } from "../src/app";
import type { AuthContext } from "../src/apply";
import { buildAudit } from "../src/audit";
import type { Reviewer } from "../src/auth";
import { storePlan } from "../src/plans";

const POLICY = policyJson as BillingPolicyV1;
const HASH = "a".repeat(64);
const AT = new Date("2026-10-22T12:00:00.000Z");

async function get(deps: Parameters<typeof buildApp>[0], url: string) {
  const app = buildApp({ webRoot: null, ...deps });
  try {
    return await app.inject({ method: "GET", url });
  } finally {
    await app.close();
  }
}

describe("audit route before touching the database", () => {
  it("is unavailable without a database", async () => {
    expect((await get({}, "/api/runs/r1/audit")).statusCode).toBe(503);
  });

  it("refuses a caller who isn't signed in", async () => {
    const res = await get({ runs: { db: {} as Db, auth: () => null } }, "/api/runs/r1/audit");
    expect(res.statusCode).toBe(401);
  });
});

describe("buildAudit: an old run keeps the rules it was approved under (T2.14)", () => {
  const manifest = PlanManifest.parse({ ...billingManifest("plan_1"), orgId: "org_1" });
  const grant = (over: Partial<typeof schema.approvalGrants.$inferSelect> = {}) => ({
    id: "grant_1",
    orgId: "org_1",
    planId: "plan_1",
    revision: 1,
    planHash: HASH,
    actorUserId: "user_fin",
    actorSessionId: "sess_fin",
    roles: ["finance_lead", "support_lead"],
    grantedAt: AT,
    expiresAt: new Date(AT.getTime() + 3_600_000),
    revokedAt: null,
    policies: [{ id: POLICY.id, version: POLICY.version, contents: POLICY }],
    ...over,
  });
  const run = {
    id: "run_1",
    orgId: "org_1",
    planId: "plan_1",
    revision: 1,
    planHash: HASH,
    approvalId: "grant_1",
    requestedBy: "user_fin",
    state: "completed",
    createdAt: AT,
    updatedAt: AT,
  };
  const input = (grants: ReturnType<typeof grant>[]) => ({
    run,
    plan: { planId: "plan_1", revision: 1, planHash: HASH, manifest },
    grants,
    attempts: [],
    receipts: [],
  });

  it("shows the policy as it was when approved, whatever the policy file says now", () => {
    // The company later halves the finance threshold. The audit reads the grant, not the file.
    const changedNow: BillingPolicyV1 = { ...POLICY, financeThresholdMinor: 5_000 };
    const audit = buildAudit(input([grant()]));
    expect(audit.policies).toHaveLength(manifest.policies.length);
    expect(audit.policies[0]?.contents).toEqual(POLICY);
    expect(audit.policies[0]?.contents).not.toEqual(changedNow);
  });

  it("says so, rather than show today's file, when the grant kept no snapshot", () => {
    const audit = buildAudit(input([grant({ policies: null })]));
    expect(audit.policies.map((p) => p.contents)).toEqual(manifest.policies.map(() => null));
  });

  it("lists every grant, marks the one the run used, and keeps revoked ones", () => {
    const revoked = grant({ id: "grant_0", revokedAt: new Date(AT.getTime() + 1_000) });
    const audit = buildAudit(input([revoked, grant()]));
    expect(audit.grants.map((g) => [g.id, g.usedByRun, g.revokedAt !== null])).toEqual([
      ["grant_0", false, true],
      ["grant_1", true, false],
    ]);
    expect(audit.grants[1]).toMatchObject({
      actorUserId: "user_fin",
      grantedAt: AT.toISOString(),
      expiresAt: new Date(AT.getTime() + 3_600_000).toISOString(),
    });
  });

  it("is labelled as stored history and carries the plan's own evidence", () => {
    const audit = buildAudit(input([grant()]));
    expect(audit.source).toBe("stored_history");
    expect(audit.plan.planHash).toBe(HASH);
    expect(audit.plan.manifest.observations.length).toBeGreaterThan(0);
  });
});

// Needs a real Postgres: `pnpm infra:up` then `DB_TESTS=1 pnpm --filter @rehearsal/api test`.
describe.skipIf(!process.env.DB_TESTS)("audit route (real Postgres)", () => {
  const url = process.env.DATABASE_URL ?? "postgres://rehearsal:rehearsal@localhost:5432/rehearsal";
  const db = createDb(url);
  beforeAll(() => migrateDb(db));
  const deps = (auth: AuthContext) => ({ runs: { db, auth: () => auth } });
  const me = (orgId: string): Reviewer => ({
    orgId,
    userId: "user_fin",
    sessionId: "sess",
    roles: ["finance_lead", "support_lead"],
  });

  async function seed() {
    const orgId = `org_${crypto.randomUUID()}`;
    const planId = `plan_${crypto.randomUUID()}`;
    const manifest = PlanManifest.parse({ ...billingManifest(planId), orgId });
    const stored = await storePlan(db, manifest);
    if (!stored) throw new Error("seed failed");
    const planHash = stored.planHash;
    const runId = `run_${crypto.randomUUID()}`;
    const grantId = `grant_${crypto.randomUUID()}`;
    await db.insert(schema.approvalGrants).values({
      id: grantId,
      orgId,
      planId,
      revision: 1,
      planHash,
      actorUserId: "user_fin",
      actorSessionId: "sess",
      roles: ["finance_lead", "support_lead"],
      grantedAt: AT,
      expiresAt: new Date(AT.getTime() + 3_600_000),
      policies: [{ id: POLICY.id, version: POLICY.version, contents: POLICY }],
    });
    await db.insert(schema.runs).values({
      id: runId,
      orgId,
      planId,
      revision: 1,
      planHash,
      approvalId: grantId,
      requestedBy: "user_fin",
      state: "completed",
    });
    await db.insert(schema.stepReceipts).values({
      id: `rcpt_${crypto.randomUUID()}`,
      orgId,
      planHash,
      actionId: "refund_001",
      receipt: { outcome: "confirmed" },
      recordedAt: AT,
    });
    return { orgId, planId, runId, planHash, grantId };
  }

  it("serves the run's own plan, policy, grants and receipts", async () => {
    const { orgId, runId, planHash, grantId } = await seed();
    const res = await get(deps(me(orgId)), `/api/runs/${runId}/audit`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe("stored_history");
    expect(body.plan.planHash).toBe(planHash);
    expect(body.policies[0].contents).toEqual(POLICY);
    expect(body.grants.map((g: { id: string; usedByRun: boolean }) => [g.id, g.usedByRun])).toEqual(
      [[grantId, true]],
    );
    expect(body.receipts.map((r: { actionId: string }) => r.actionId)).toEqual(["refund_001"]);
  });

  it("hides another org's run", async () => {
    const { runId } = await seed();
    const res = await get(deps(me("org_other")), `/api/runs/${runId}/audit`);
    expect(res.statusCode).toBe(404);
  });
});
