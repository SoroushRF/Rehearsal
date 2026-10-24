import { PlanManifest } from "@rehearsal/contracts";
import type { BillingPolicy, BillingPolicyV1 } from "@rehearsal/core";
import { createDb, type Db, migrateDb, type PgBoss, schema, startQueue } from "@rehearsal/db";
import { billingManifest } from "@rehearsal/testkit";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import policyJson from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import policyV3Json from "../../../scenarios/billing/policy.v3.json" with { type: "json" };
import { buildApp } from "../src/app";
import type { Reviewer } from "../src/auth";
import { storePlan } from "../src/plans";

const POLICY = policyJson as BillingPolicyV1;
const POLICY_V3 = policyV3Json as BillingPolicy;
const NOW = new Date("2026-10-22T12:00:00.000Z");
const TTL = 60 * 60 * 1000;
const HASH = "a".repeat(64);

const reviewer = (orgId: string, roles: Reviewer["roles"], userId = "user_1"): Reviewer => ({
  orgId,
  userId,
  sessionId: `sess_${userId}`,
  roles,
});
const finance = (orgId: string) => reviewer(orgId, ["finance_lead", "support_lead"], "user_fin");
const support = (orgId: string) => reviewer(orgId, ["support_lead"], "user_sup");

async function send(
  deps: Parameters<typeof buildApp>[0],
  method: "GET" | "POST",
  url: string,
  payload?: object,
) {
  const app = buildApp({ webRoot: null, ...deps });
  try {
    return await app.inject({ method, url, ...(payload ? { payload } : {}) });
  } finally {
    await app.close();
  }
}

describe("approval routes before touching the database", () => {
  const as = (me: Reviewer | null) => ({
    approvals: { db: {} as Db, reviewer: () => me, policies: [POLICY] },
  });

  it("are unavailable without a database", async () => {
    expect((await send({}, "POST", "/api/plans/p1/approvals", {})).statusCode).toBe(503);
  });

  it.each([
    ["GET", "/api/plans/p1/approvals"],
    ["POST", "/api/plans/p1/approvals"],
    ["POST", "/api/plans/p1/approvals/g1/revoke"],
  ] as const)("%s %s refuses a caller who isn't signed in", async (method, url) => {
    const res = await send(as(null), method, url, method === "POST" ? {} : undefined);
    expect(res.statusCode).toBe(401);
  });

  it("refuses a member with no approving role", async () => {
    const readOnly = as(reviewer("org_1", []));
    const approve = await send(readOnly, "POST", "/api/plans/p1/approvals", {
      revision: 1,
      planHash: HASH,
    });
    expect(approve.statusCode).toBe(403);
    expect((await send(readOnly, "POST", "/api/plans/p1/approvals/g1/revoke", {})).statusCode).toBe(
      403,
    );
  });

  it.each([
    ["missing fields", { revision: 1 }],
    ["a malformed hash", { revision: 1, planHash: "abc" }],
    [
      "action bodies alongside a valid revision and hash",
      { revision: 1, planHash: HASH, actions: [] },
    ],
  ])("refuses a body with %s", async (_label, body) => {
    const res = await send(as(finance("org_1")), "POST", "/api/plans/p1/approvals", body);
    expect(res.statusCode).toBe(400);
  });
});

// Needs a real Postgres: `pnpm infra:up` then `DB_TESTS=1 pnpm --filter @rehearsal/api test`.
describe.skipIf(!process.env.DB_TESTS)("approval routes (real Postgres)", () => {
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

  /** One app that can approve (at NOW), revise and apply (at `applyAt`) as the given reviewer. */
  const deps = (me: Reviewer | null, applyAt = NOW) => ({
    approvals: {
      db,
      reviewer: () => me,
      policies: [POLICY, POLICY_V3],
      now: () => NOW,
      ttlMs: TTL,
    },
    plans: { db, auth: () => me },
    apply: { db, boss, auth: () => me, now: () => applyAt, policies: [POLICY, POLICY_V3] },
  });

  async function seed(edit: (m: PlanManifest) => PlanManifest = (m) => m) {
    const orgId = `org_${crypto.randomUUID()}`;
    const planId = `plan_${crypto.randomUUID()}`;
    const manifest = PlanManifest.parse(edit({ ...billingManifest(planId), orgId }));
    const stored = await storePlan(db, manifest);
    if (!stored) throw new Error("seed failed");
    return { orgId, planId, hash: stored.planHash };
  }
  const approve = (me: Reviewer | null, planId: string, body: object) =>
    send(deps(me), "POST", `/api/plans/${planId}/approvals`, body);
  const grantsFor = (planId: string) =>
    db.select().from(schema.approvalGrants).where(eq(schema.approvalGrants.planId, planId));

  it("binds a finance lead's grant to the org, revision, hash, actor and expiry", async () => {
    const { orgId, planId, hash } = await seed();
    const res = await approve(finance(orgId), planId, { revision: 1, planHash: hash });
    expect(res.statusCode).toBe(201);
    const { grant, existing } = res.json();
    expect(existing).toBe(false);
    expect(grant).toMatchObject({
      orgId,
      planId,
      revision: 1,
      planHash: hash,
      actorUserId: "user_fin",
      actorSessionId: "sess_user_fin",
      roles: ["finance_lead", "support_lead"],
      grantedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + TTL).toISOString(),
      revokedAt: null,
    });

    const again = await approve(finance(orgId), planId, { revision: 1, planHash: hash });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ grant, existing: true });
    expect(await grantsFor(planId)).toHaveLength(1);
  });

  it("replies only after the grant has committed", async () => {
    const { orgId, planId, hash } = await seed();
    let committed = false;
    const watched = new Proxy(db, {
      get: (target, prop) =>
        prop === "transaction"
          ? async (fn: Parameters<Db["transaction"]>[0]) => {
              const out = await target.transaction(fn);
              committed = true;
              return out;
            }
          : Reflect.get(target, prop),
    });
    const app = buildApp({
      webRoot: null,
      approvals: {
        db: watched,
        reviewer: () => finance(orgId),
        policies: [POLICY],
        now: () => NOW,
      },
    });
    let committedAtSend: boolean | null = null;
    app.addHook("onSend", async () => {
      committedAtSend = committed;
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/plans/${planId}/approvals`,
        payload: { revision: 1, planHash: hash },
      });
      expect(res.statusCode).toBe(201);
      expect(committedAtSend).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("the grant is what apply needs (visible to T3)", async () => {
    const { orgId, planId, hash } = await seed();
    await approve(finance(orgId), planId, { revision: 1, planHash: hash });
    const res = await send(deps(finance(orgId)), "POST", `/api/plans/${planId}/apply`, {
      revision: 1,
      planHash: hash,
    });
    expect(res.statusCode).toBe(202);
  });

  it("refuses another organization's plan and stores nothing", async () => {
    const { planId, hash } = await seed();
    const res = await approve(finance("org_other"), planId, { revision: 1, planHash: hash });
    expect(res.statusCode).toBe(404);
    expect(await grantsFor(planId)).toEqual([]);
  });

  it("refuses a support lead when a refund over the threshold needs finance", async () => {
    const { orgId, planId, hash } = await seed();
    const res = await approve(support(orgId), planId, { revision: 1, planHash: hash });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      error: "missing_roles",
      missing: ["finance_lead"],
      held: ["support_lead"],
    });
    expect(await grantsFor(planId)).toEqual([]);
  });

  it("lets a support lead approve once the finance-only refund is unchecked", async () => {
    const { orgId, planId, hash } = await seed();
    const revised = await send(deps(support(orgId)), "POST", `/api/plans/${planId}/revisions`, {
      baseRevision: 1,
      basePlanHash: hash,
      excludeActionIds: ["refund_002"],
    });
    expect(revised.statusCode).toBe(201);
    const { revision, planHash } = revised.json();
    const res = await approve(support(orgId), planId, { revision, planHash });
    expect(res.statusCode).toBe(201);
    expect(res.json().grant).toMatchObject({ revision: 2, planHash, roles: ["support_lead"] });
  });

  it("refuses a stale revision and a changed hash", async () => {
    const { orgId, planId, hash } = await seed();
    expect(
      (await approve(finance(orgId), planId, { revision: 1, planHash: "f".repeat(64) })).json(),
    ).toEqual({ error: "hash_mismatch" });

    await send(deps(finance(orgId)), "POST", `/api/plans/${planId}/revisions`, {
      baseRevision: 1,
      basePlanHash: hash,
      excludeActionIds: ["patch_001"],
    });
    const stale = await approve(finance(orgId), planId, { revision: 1, planHash: hash });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: "stale_revision", latestRevision: 2 });
    expect(await grantsFor(planId)).toEqual([]);
  });

  it("an expired grant no longer lets the plan apply", async () => {
    const { orgId, planId, hash } = await seed();
    await approve(finance(orgId), planId, { revision: 1, planHash: hash });
    const later = new Date(NOW.getTime() + TTL);
    const res = await send(deps(finance(orgId), later), "POST", `/api/plans/${planId}/apply`, {
      revision: 1,
      planHash: hash,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("approval_invalid");
  });

  it("a revoked grant no longer lets the plan apply, and revoking is idempotent", async () => {
    const { orgId, planId, hash } = await seed();
    const { grant } = (
      await approve(finance(orgId), planId, { revision: 1, planHash: hash })
    ).json();

    const revoke = () =>
      send(deps(support(orgId)), "POST", `/api/plans/${planId}/approvals/${grant.id}/revoke`, {});
    const first = await revoke();
    expect(first.statusCode).toBe(200);
    expect(first.json().grant.revokedAt).toBe(NOW.toISOString());
    expect((await revoke()).json()).toMatchObject({ existing: true });

    const res = await send(deps(finance(orgId)), "POST", `/api/plans/${planId}/apply`, {
      revision: 1,
      planHash: hash,
    });
    expect(res.statusCode).toBe(403);

    const { grants } = (
      await send(deps(finance(orgId)), "GET", `/api/plans/${planId}/approvals`)
    ).json();
    expect(grants).toMatchObject([{ id: grant.id, live: false }]);
  });

  it("refuses to revoke another org's grant", async () => {
    const { orgId, planId, hash } = await seed();
    const { grant } = (
      await approve(finance(orgId), planId, { revision: 1, planHash: hash })
    ).json();
    const res = await send(
      deps(finance("org_other")),
      "POST",
      `/api/plans/${planId}/approvals/${grant.id}/revoke`,
      {},
    );
    expect(res.statusCode).toBe(404);
    const [row] = await grantsFor(planId);
    expect(row?.revokedAt).toBeNull();
  });

  it("refuses a plan that breaks policy, as admission would", async () => {
    // A refund over the threshold that claims only to need a support lead (R3).
    const { orgId, planId, hash } = await seed((m) => ({
      ...m,
      actions: m.actions.map((a) =>
        a.id === "refund_002" ? { ...a, requiredRole: "support_lead" as const } : a,
      ),
    }));
    const res = await approve(finance(orgId), planId, { revision: 1, planHash: hash });
    expect(res.statusCode).toBe(422);
    expect(res.json().violations.map((v: { rule: string }) => v.rule)).toEqual([
      "R3.finance_threshold",
    ]);
  });

  it("refuses a plan under a policy this API doesn't have", async () => {
    const { orgId, planId, hash } = await seed((m) => ({
      ...m,
      policies: [{ id: "billing-remedy", version: 2 }],
    }));
    const res = await approve(finance(orgId), planId, { revision: 1, planHash: hash });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("unknown_policy");
  });
});

// Decision 0011. A plan that cites policy v3 and has a refund above the line needs two people.
describe.skipIf(!process.env.DB_TESTS)("two distinct approvers (real Postgres)", () => {
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

  const both = (orgId: string) => reviewer(orgId, ["finance_lead", "support_lead"], "user_boss");
  const financeOnly = (orgId: string) => reviewer(orgId, ["finance_lead"], "user_fin");
  const deps = (me: Reviewer | null) => ({
    approvals: {
      db,
      reviewer: () => me,
      policies: [POLICY, POLICY_V3],
      now: () => NOW,
      ttlMs: TTL,
    },
    apply: { db, boss, auth: () => me, now: () => NOW, policies: [POLICY, POLICY_V3] },
  });

  async function seed() {
    const orgId = `org_${crypto.randomUUID()}`;
    const planId = `plan_${crypto.randomUUID()}`;
    const base = { ...billingManifest(planId), orgId };
    const manifest = PlanManifest.parse({ ...base, policies: [{ id: POLICY_V3.id, version: 3 }] });
    const stored = await storePlan(db, manifest);
    if (!stored) throw new Error("seed failed");
    return { orgId, planId, hash: stored.planHash };
  }
  const approve = (me: Reviewer, planId: string, hash: string) =>
    send(deps(me), "POST", `/api/plans/${planId}/approvals`, { revision: 1, planHash: hash });
  const apply = (me: Reviewer, planId: string, hash: string) =>
    send(deps(me), "POST", `/api/plans/${planId}/apply`, { revision: 1, planHash: hash });

  it("lets a support lead sign a plan with a finance-only refund, and says the finance seat is open", async () => {
    const { orgId, planId, hash } = await seed();
    const res = await approve(support(orgId), planId, hash);
    expect(res.statusCode).toBe(201);
    expect(res.json().approval).toMatchObject({
      dualRequired: true,
      satisfied: false,
      needed: ["finance_lead"],
    });
  });

  it("refuses apply with one signature, and with one person holding both roles", async () => {
    const { orgId, planId, hash } = await seed();
    await approve(both(orgId), planId, hash);
    const again = await approve(both(orgId), planId, hash); // the same person can't fill the second seat
    expect(again.json()).toMatchObject({ existing: true, approval: { satisfied: false } });
    const res = await apply(both(orgId), planId, hash);
    expect(res.statusCode).toBe(403);
    expect(res.json().detail).toMatch(/two different approvers/);
  });

  it("accepts apply once a support lead and a different finance lead have signed", async () => {
    const { orgId, planId, hash } = await seed();
    await approve(financeOnly(orgId), planId, hash);
    const second = await approve(support(orgId), planId, hash);
    expect(second.json().approval).toMatchObject({ satisfied: true, needed: [] });
    expect((await apply(financeOnly(orgId), planId, hash)).statusCode).toBe(202);
  });

  it("shows who signed which seat when approvals are listed", async () => {
    const { orgId, planId, hash } = await seed();
    await approve(financeOnly(orgId), planId, hash);
    const { approval } = (
      await send(deps(support(orgId)), "GET", `/api/plans/${planId}/approvals`)
    ).json();
    expect(approval).toMatchObject({
      dualRequired: true,
      satisfied: false,
      signed: [{ role: "finance_lead", actorUserId: "user_fin" }],
      needed: ["support_lead"],
    });
  });

  it("stops being satisfied when either signer's grant is revoked", async () => {
    const { orgId, planId, hash } = await seed();
    await approve(financeOnly(orgId), planId, hash);
    const { grant } = (await approve(support(orgId), planId, hash)).json();
    const revoked = await send(
      deps(support(orgId)),
      "POST",
      `/api/plans/${planId}/approvals/${grant.id}/revoke`,
      {},
    );
    expect(revoked.statusCode).toBe(200);
    const res = await apply(financeOnly(orgId), planId, hash);
    expect(res.statusCode).toBe(403);
    expect(res.json().detail).toMatch(/still needed: support_lead/);
  });
});
