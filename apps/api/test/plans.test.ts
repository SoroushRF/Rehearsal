import { PlanManifest } from "@rehearsal/contracts";
import { planHash } from "@rehearsal/core";
import { createDb, type Db, migrateDb, schema } from "@rehearsal/db";
import { billingManifest } from "@rehearsal/testkit";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { storePlan } from "../src/plans";
import { bearer, type Caller, fakeIam, support } from "./fake-iam";

const HASH = "a".repeat(64);

async function call(
  deps: Parameters<typeof buildApp>[0],
  method: "GET" | "POST",
  url: string,
  payload?: object,
  person?: Caller | null,
) {
  const app = buildApp({ webRoot: null, ...deps });
  try {
    return await app.inject({
      method,
      url,
      headers: person ? bearer(person) : {},
      ...(payload ? { payload } : {}),
    });
  } finally {
    await app.close();
  }
}

describe("plan routes without a database", () => {
  it.each([
    ["GET", "/api/plans"],
    ["GET", "/api/plans/p1"],
    ["POST", "/api/plans/p1/revisions"],
  ] as const)("%s %s says unavailable, not missing", async (method, url) => {
    const res = await call({}, method, url, method === "POST" ? {} : undefined);
    expect(res.statusCode).toBe(503);
  });
});

describe("plan routes before touching the database", () => {
  // Auth and body checks come first, so a stub database is never reached.
  const db = {} as Db;
  const as = (person: Caller | null) => ({
    plans: { db, iam: fakeIam(person ? [person] : []) },
  });
  const user = support("org_1");

  it.each([
    ["GET", "/api/plans"],
    ["GET", "/api/plans/p1"],
    ["POST", "/api/plans/p1/revisions"],
  ] as const)("%s %s refuses an unauthenticated caller", async (method, url) => {
    const res = await call(as(null), method, url, method === "POST" ? {} : undefined, null);
    expect(res.statusCode).toBe(401);
  });

  it.each([
    ["missing fields", { excludeActionIds: ["refund_001"] }],
    ["no actions to exclude", { baseRevision: 1, basePlanHash: HASH, excludeActionIds: [] }],
    ["a malformed hash", { baseRevision: 1, basePlanHash: "abc", excludeActionIds: ["x"] }],
    [
      "action bodies alongside valid fields",
      { baseRevision: 1, basePlanHash: HASH, excludeActionIds: ["x"], actions: [] },
    ],
  ])("refuses a revision request with %s", async (_label, body) => {
    const res = await call(as(user), "POST", "/api/plans/p1/revisions", body, user);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_request" });
  });

  it("refuses a malformed revision query", async () => {
    const res = await call(as(user), "GET", "/api/plans/p1?revision=zero", undefined, user);
    expect(res.statusCode).toBe(400);
  });
});

// Needs a real Postgres: `pnpm infra:up` then `DB_TESTS=1 pnpm --filter @rehearsal/api test`.
describe.skipIf(!process.env.DB_TESTS)("plan routes (real Postgres)", () => {
  const url = process.env.DATABASE_URL ?? "postgres://rehearsal:rehearsal@localhost:5432/rehearsal";
  const db = createDb(url);
  beforeAll(() => migrateDb(db));

  /** A fresh org holding revision 1 of the two-customer billing fixture. */
  async function seed() {
    const orgId = `org_${crypto.randomUUID()}`;
    const planId = `plan_${crypto.randomUUID()}`;
    const manifest = PlanManifest.parse({ ...billingManifest(planId), orgId });
    const stored = await storePlan(db, manifest);
    if (!stored) throw new Error("seed failed");
    return { orgId, planId, manifest, hash: stored.planHash, user: support(orgId) };
  }
  const deps = (person: Caller | null) => ({ plans: { db, iam: fakeIam(person ? [person] : []) } });
  const exclude = (person: Caller, planId: string, body: object) =>
    call(deps(person), "POST", `/api/plans/${planId}/revisions`, body, person);

  it("returns the stored latest revision with its hash", async () => {
    const { planId, manifest, hash, user } = await seed();
    const res = await call(deps(user), "GET", `/api/plans/${planId}`, undefined, user);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ planId, revision: 1, planHash: hash, latestRevision: 1 });
    expect(body.manifest).toEqual(manifest);
    expect(planHash(body.manifest)).toBe(hash);
  });

  it("hides another org's plan", async () => {
    const { planId } = await seed();
    const other = support("org_other");
    const res = await call(deps(other), "GET", `/api/plans/${planId}`, undefined, other);
    expect(res.statusCode).toBe(404);
  });

  it("refuses to store the same revision twice", async () => {
    const { manifest } = await seed();
    expect(await storePlan(db, manifest)).toBeNull();
  });

  it("excluding refund_001 creates revision 2 without it or its dependent note", async () => {
    const { planId, manifest, hash, user } = await seed();
    const res = await exclude(user, planId, {
      baseRevision: 1,
      basePlanHash: hash,
      excludeActionIds: ["refund_001"],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ planId, revision: 2, parentRevision: 1 });
    expect(body.dropped).toEqual([
      { actionId: "refund_001", reason: "reviewer" },
      { actionId: "note_001", reason: "dependency" },
    ]);
    const ids = body.manifest.actions.map((a: { id: string }) => a.id);
    expect(ids).not.toContain("refund_001");
    expect(ids).not.toContain("note_001");
    expect(ids).toHaveLength(manifest.actions.length - 2);
    expect(body.planHash).toBe(planHash(body.manifest));
    expect(body.planHash).not.toBe(hash);

    // Revision 1 is untouched and still readable; the latest is now 2.
    const v1 = (
      await call(deps(user), "GET", `/api/plans/${planId}?revision=1`, undefined, user)
    ).json();
    expect(v1).toMatchObject({ revision: 1, planHash: hash, latestRevision: 2 });
    expect(v1.manifest).toEqual(manifest);
    const latest = (await call(deps(user), "GET", `/api/plans/${planId}`, undefined, user)).json();
    expect(latest).toMatchObject({ revision: 2, planHash: body.planHash });
  });

  it("refuses a base hash that doesn't match the stored revision", async () => {
    const { planId, user } = await seed();
    const res = await exclude(user, planId, {
      baseRevision: 1,
      basePlanHash: "f".repeat(64),
      excludeActionIds: ["refund_001"],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "hash_mismatch" });
  });

  it("refuses to fork from a revision that is no longer the latest", async () => {
    const { planId, hash, user } = await seed();
    const body = { baseRevision: 1, basePlanHash: hash, excludeActionIds: ["patch_001"] };
    expect((await exclude(user, planId, body)).statusCode).toBe(201);
    const again = await exclude(user, planId, { ...body, excludeActionIds: ["patch_002"] });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: "stale_revision", latestRevision: 2 });
  });

  it("refuses unknown action IDs and stores nothing", async () => {
    const { orgId, planId, hash, user } = await seed();
    const res = await exclude(user, planId, {
      baseRevision: 1,
      basePlanHash: hash,
      excludeActionIds: ["refund_001", "refund_999"],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "unknown_actions", actionIds: ["refund_999"] });
    const rows = await db
      .select()
      .from(schema.planVersions)
      .where(and(eq(schema.planVersions.orgId, orgId), eq(schema.planVersions.planId, planId)));
    expect(rows).toHaveLength(1);
  });

  it("replies only after the new revision has committed", async () => {
    const { planId, hash, user } = await seed();
    // Records whether the transaction had committed by the time the response went out.
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
    const app = buildApp({ webRoot: null, plans: { db: watched, iam: fakeIam([user]) } });
    let committedAtSend: boolean | null = null;
    app.addHook("onSend", async () => {
      committedAtSend = committed;
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/plans/${planId}/revisions`,
        headers: bearer(user),
        payload: { baseRevision: 1, basePlanHash: hash, excludeActionIds: ["patch_001"] },
      });
      expect(res.statusCode).toBe(201);
      expect(committedAtSend).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("creates exactly one revision under concurrent requests", async () => {
    const { planId, hash, user } = await seed();
    const results = await Promise.all(
      ["refund_001", "patch_001", "refund_002", "patch_002", "note_002"].map((id) =>
        exclude(user, planId, { baseRevision: 1, basePlanHash: hash, excludeActionIds: [id] }),
      ),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(4);
  });

  it("never serves a stored manifest that no longer matches its hash", async () => {
    const { orgId, planId, manifest, hash, user } = await seed();
    const tampered = { ...manifest, actions: manifest.actions.slice(1) };
    await db
      .update(schema.planVersions)
      .set({ manifest: tampered })
      .where(and(eq(schema.planVersions.orgId, orgId), eq(schema.planVersions.planId, planId)));

    expect(
      (await call(deps(user), "GET", `/api/plans/${planId}`, undefined, user)).statusCode,
    ).toBe(500);
    const res = await exclude(user, planId, {
      baseRevision: 1,
      basePlanHash: hash,
      excludeActionIds: ["patch_001"],
    });
    expect(res.statusCode).toBe(500);
  });

  it("lists the latest revision of each of the org's plans", async () => {
    const { orgId, planId, hash, user } = await seed();
    const other = PlanManifest.parse({ ...billingManifest(`plan_${crypto.randomUUID()}`), orgId });
    await storePlan(db, other);
    await exclude(user, planId, {
      baseRevision: 1,
      basePlanHash: hash,
      excludeActionIds: ["patch_001"],
    });

    const { plans } = (await call(deps(user), "GET", "/api/plans", undefined, user)).json();
    expect(plans).toHaveLength(2);
    expect(
      plans.map((p: { planId: string; revision: number }) => [p.planId, p.revision]).sort(),
    ).toEqual(
      [
        [other.planId, 1],
        [planId, 2],
      ].sort(),
    );
    expect(plans[0].incidentId).toBe("INC-BILL-0927");
  });
});
