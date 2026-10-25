import { PlanManifest } from "@rehearsal/contracts";
import { excludeActions, planHash, rehearsalOperationKey } from "@rehearsal/core";
import {
  createDb,
  type Db,
  listRehearsalsForPlan,
  loadRehearsal,
  migrateDb,
  type PgBoss,
  saveRehearsalReport,
  schema,
  startQueue,
  transitionRehearsal,
} from "@rehearsal/db";
import { billingManifest, rehearsalReportFixture } from "@rehearsal/testkit";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { storePlan } from "../src/plans";
import { bearer, type Caller, fakeIam, member, support } from "./fake-iam";

const HASH = "a".repeat(64);
const NOW = new Date("2026-10-25T12:00:00.000Z");
const CLEAN = { id: "clean", version: 1 } as const;

async function send(
  deps: Parameters<typeof buildApp>[0],
  method: "GET" | "POST",
  url: string,
  opts: { payload?: object; person?: Caller | null; headers?: Record<string, string> } = {},
) {
  const app = buildApp({ webRoot: null, ...deps });
  try {
    return await app.inject({
      method,
      url,
      headers: { ...(opts.person ? bearer(opts.person) : {}), ...opts.headers },
      ...(opts.payload ? { payload: opts.payload } : {}),
    });
  } finally {
    await app.close();
  }
}

describe("execution rehearsal routes without a database", () => {
  it.each([
    ["GET", "/api/plans/p1/execution-rehearsals"],
    ["POST", "/api/plans/p1/execution-rehearsals"],
    ["GET", "/api/execution-rehearsals/abcd1234/report"],
  ] as const)("%s %s says unavailable, not missing", async (method, url) => {
    const res = await send({}, method, url, method === "POST" ? { payload: {} } : {});
    expect(res.statusCode).toBe(503);
  });
});

describe("execution rehearsal routes before touching the database", () => {
  // Auth and body checks come first, so a stub database and queue are never reached.
  const stub = { db: {} as Db, boss: {} as PgBoss };
  const user = support("org_1");
  const as = (person: Caller | null) => ({
    executionRehearsals: { ...stub, iam: fakeIam(person ? [person] : []) },
  });
  const ok = { planId: "p1", revision: 1, planHash: HASH, scenario: CLEAN };

  it.each([
    ["GET", "/api/plans/p1/execution-rehearsals"],
    ["POST", "/api/plans/p1/execution-rehearsals"],
    ["GET", "/api/execution-rehearsals/abcd1234/report"],
  ] as const)("%s %s refuses an unauthenticated caller", async (method, url) => {
    const res = await send(as(null), method, url, method === "POST" ? { payload: ok } : {});
    expect(res.statusCode).toBe(401);
  });

  it.each([
    ["missing fields", { planId: "p1" }],
    ["a malformed hash", { ...ok, planHash: "abc" }],
    ["an unknown scenario", { ...ok, scenario: { id: "drop_tables", version: 1 } }],
    ["another plan than the URL", { ...ok, planId: "p2" }],
    ["action bodies", { ...ok, actions: [{ kind: "stripe.refund.create" }] }],
    ["a URL", { ...ok, url: "http://operational.invalid" }],
    ["a fault body", { ...ok, scenario: { ...CLEAN, faults: [{ status: 429 }] } }],
    ["a tenant", { ...ok, tenant: "rh-someone-else" }],
  ])("refuses a request with %s", async (_label, payload) => {
    const res = await send(as(user), "POST", "/api/plans/p1/execution-rehearsals", {
      payload,
      person: user,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_request" });
  });

  it("refuses a malformed idempotency key", async () => {
    const res = await send(as(user), "POST", "/api/plans/p1/execution-rehearsals", {
      payload: ok,
      person: user,
      headers: { "idempotency-key": "no spaces allowed" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_idempotency_key" });
  });

  it("refuses a malformed revision query on the report", async () => {
    const res = await send(
      as(user),
      "GET",
      "/api/execution-rehearsals/abcd1234/report?revision=0",
      {
        person: user,
      },
    );
    expect(res.statusCode).toBe(400);
  });
});

// Needs a real Postgres: `pnpm infra:up` then `DB_TESTS=1 pnpm --filter @rehearsal/api test`.
describe.skipIf(!process.env.DB_TESTS)("execution rehearsal routes (real Postgres)", () => {
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

  /** A fresh org holding revision 1 of the two-customer billing fixture. */
  async function seed() {
    const orgId = `org_${crypto.randomUUID()}`;
    const planId = `plan_${crypto.randomUUID()}`;
    const manifest = PlanManifest.parse({ ...billingManifest(planId), orgId });
    const stored = await storePlan(db, manifest);
    if (!stored) throw new Error("seed failed");
    return {
      orgId,
      planId,
      manifest,
      hash: stored.planHash,
      user: support(orgId),
      reader: member(orgId),
    };
  }
  type Seed = Awaited<ReturnType<typeof seed>>;

  const deps = (people: Caller[], extra: object = {}) => ({
    // The fixture plan's evidence is v1, which the seeder refuses; the test below keeps the real check.
    executionRehearsals: {
      db,
      boss,
      iam: fakeIam(people),
      now: () => NOW,
      checkSnapshot: () => ({ ok: true as const }),
      ...extra,
    },
  });
  const body = (s: Seed, over: object = {}) => ({
    planId: s.planId,
    revision: 1,
    planHash: s.hash,
    scenario: CLEAN,
    ...over,
  });
  const start = (s: Seed, person: Caller, over: object = {}, headers?: Record<string, string>) =>
    send(deps([person]), "POST", `/api/plans/${s.planId}/execution-rehearsals`, {
      payload: body(s, over),
      person,
      ...(headers && { headers }),
    });
  const list = (s: Seed, person: Caller) =>
    send(deps([person]), "GET", `/api/plans/${s.planId}/execution-rehearsals`, { person });
  const count = async (s: Seed) => (await listRehearsalsForPlan(db, s.orgId, s.planId)).length;

  /** Revision 2 without refund_001 and its note. */
  async function reviseOnce(s: Seed) {
    const next = excludeActions(s.manifest, ["refund_001"]);
    await storePlan(db, next);
    return planHash(next);
  }

  it("queues one rehearsal of the stored plan and lists it", async () => {
    const s = await seed();
    const res = await start(s, s.user);
    expect(res.statusCode).toBe(201);
    const { rehearsal, existing } = res.json();
    expect(existing).toBe(false);
    expect(rehearsal).toMatchObject({
      plan: { orgId: s.orgId, planId: s.planId, revision: 1, planHash: s.hash },
      scenario: CLEAN,
      state: "queued",
      detail: null,
      requestedBy: s.user.userId,
    });
    // The server bound the snapshot and policy from the stored manifest.
    const stored = await loadRehearsal(db, s.orgId, rehearsal.rehearsalId);
    expect(stored?.rehearsal.policyId).toBe(s.manifest.policies[0]?.id);

    const got = await list(s, s.reader);
    expect(got.statusCode).toBe(200);
    expect(got.json().rehearsals.map((r: { rehearsalId: string }) => r.rehearsalId)).toEqual([
      rehearsal.rehearsalId,
    ]);
  });

  it("returns the same job for an identical request, however often or concurrently", async () => {
    const s = await seed();
    const first = await start(s, s.user);
    const again = await start(s, s.user);
    expect(again.statusCode).toBe(200);
    expect(again.json().existing).toBe(true);
    expect(again.json().rehearsal.rehearsalId).toBe(first.json().rehearsal.rehearsalId);

    const t = await seed();
    const racing = await Promise.all(Array.from({ length: 6 }, () => start(t, t.user)));
    expect(new Set(racing.map((r) => r.json().rehearsal.rehearsalId)).size).toBe(1);
    expect(racing.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(await count(t)).toBe(1);
  });

  it("honours a caller's Idempotency-Key, and refuses it for a different request", async () => {
    const s = await seed();
    const key = { "idempotency-key": "retry-key-0001" };
    const first = await start(s, s.user, {}, key);
    const same = await start(s, s.user, {}, key);
    expect(same.json().rehearsal.rehearsalId).toBe(first.json().rehearsal.rehearsalId);
    expect(same.json().existing).toBe(true);

    const nextHash = await reviseOnce(s);
    const changed = await start(s, s.user, { revision: 2, planHash: nextHash }, key);
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toEqual({ error: "idempotency_conflict" });
    expect(await count(s)).toBe(1);
  });

  it("makes a retry after a failure a new rehearsal, never the failed one", async () => {
    const s = await seed();
    const first = (await start(s, s.user)).json().rehearsal.rehearsalId as string;
    expect(
      await transitionRehearsal(db, s.orgId, first, ["queued"], "failed", {
        now: NOW,
        detail: "Era was unreachable.",
      }),
    ).toBe(true);

    const failed = (await list(s, s.user)).json().rehearsals[0];
    expect(failed).toMatchObject({ state: "failed", detail: "Era was unreachable." });

    const retry = await start(s, s.user);
    expect(retry.statusCode).toBe(201);
    expect(retry.json().rehearsal.rehearsalId).not.toBe(first);
    expect(await count(s)).toBe(2);
    // The failed one stays as it was.
    expect((await loadRehearsal(db, s.orgId, first))?.state).toBe("failed");
  });

  it("refuses a stale hash, a stale revision, an unknown revision and an unsupported scenario", async () => {
    const s = await seed();
    const wrongHash = await start(s, s.user, { planHash: "b".repeat(64) });
    expect(wrongHash.statusCode).toBe(409);
    expect(wrongHash.json()).toEqual({ error: "hash_mismatch" });

    const nextHash = await reviseOnce(s);
    const stale = await start(s, s.user);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: "stale_revision", latestRevision: 2 });

    const unknown = await start(s, s.user, { revision: 9, planHash: nextHash });
    expect(unknown.statusCode).toBe(404);

    const phantom = await start(s, s.user, {
      revision: 2,
      planHash: nextHash,
      // Every catalog scenario is runnable now (T3.16); a version the catalog doesn't publish isn't.
      scenario: { id: "phantom_membership", version: 2 },
    });
    expect(phantom.statusCode).toBe(400);
    expect(phantom.json()).toEqual({ error: "unsupported_scenario" });
    const oldVersion = await start(s, s.user, {
      revision: 2,
      planHash: nextHash,
      scenario: { id: "clean", version: 2 },
    });
    expect(oldVersion.statusCode).toBe(400);

    expect(await count(s)).toBe(0);
    // Revision 2 can be rehearsed, and is tied to its own hash.
    const ok = await start(s, s.user, { revision: 2, planHash: nextHash });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().rehearsal.plan).toMatchObject({ revision: 2, planHash: nextHash });
  });

  it("refuses a plan whose evidence can't be rebuilt in a disposable world", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const planId = `plan_${crypto.randomUUID()}`;
    const base = PlanManifest.parse({ ...billingManifest(planId), orgId });
    const first = base.observations[0];
    if (!first) throw new Error("fixture has no observation");
    const thin = PlanManifest.parse({
      ...base,
      observations: base.observations.map((o) =>
        o.id === first.id ? { ...o, projectionVersion: "stripe.charge.v1" } : o,
      ),
    });
    const stored = await storePlan(db, thin);
    const user = support(orgId);
    const res = await send(
      deps([user], { checkSnapshot: undefined }),
      "POST",
      `/api/plans/${planId}/execution-rehearsals`,
      {
        payload: { planId, revision: 1, planHash: stored?.planHash, scenario: CLEAN },
        person: user,
      },
    );
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("unsupported_snapshot");
    expect(res.json().detail).toContain(first.id);
    expect(await listRehearsalsForPlan(db, orgId, planId)).toHaveLength(0);
  });

  it("lets a read-only member read rehearsals but not start one", async () => {
    const s = await seed();
    const refused = await start(s, s.reader);
    expect(refused.statusCode).toBe(403);
    expect(await count(s)).toBe(0);
    expect((await list(s, s.reader)).statusCode).toBe(200);
  });

  it("shows another organization nothing: not the plan, not its rehearsals, not a report", async () => {
    const s = await seed();
    const id = (await start(s, s.user)).json().rehearsal.rehearsalId as string;
    const outsider = support("org_someone_else");

    const asked = await start(s, outsider);
    expect(asked.statusCode).toBe(404);
    expect(asked.json()).toEqual({ error: "plan_not_found" });
    expect((await list(s, outsider)).statusCode).toBe(404);
    const report = await send(deps([outsider]), "GET", `/api/execution-rehearsals/${id}/report`, {
      person: outsider,
    });
    expect(report.statusCode).toBe(404);
    // The same answer as for a rehearsal that doesn't exist.
    const missing = await send(
      deps([outsider]),
      "GET",
      "/api/execution-rehearsals/doesnotexist1/report",
      { person: outsider },
    );
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual(report.json());
    expect(await count(s)).toBe(1);
  });

  describe("cancel", () => {
    const cancel = (id: string, person: Caller) =>
      send(deps([person]), "POST", `/api/execution-rehearsals/${id}/cancel`, { person });

    it("cancels one that hasn't ended, once; a second cancel says it already ended", async () => {
      const s = await seed();
      const id = (await start(s, s.user)).json().rehearsal.rehearsalId as string;
      const res = await cancel(id, s.user);
      expect(res.statusCode).toBe(200);
      expect(res.json().rehearsal).toMatchObject({ rehearsalId: id, state: "cancelled" });
      expect(res.json().rehearsal.detail).toMatch(/read back, not re-sent/);
      const again = await cancel(id, s.user);
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ error: "rehearsal_ended" });
      // Cancelled is final: an identical request is a new rehearsal, never the cancelled one.
      const retried = await start(s, s.user);
      expect(retried.statusCode).toBe(201);
      expect(retried.json().rehearsal.rehearsalId).not.toBe(id);
    });

    it("refuses a read-only member, and shows another org the same 404 as a missing one", async () => {
      const s = await seed();
      const id = (await start(s, s.user)).json().rehearsal.rehearsalId as string;
      expect((await cancel(id, s.reader)).statusCode).toBe(403);
      const outsider = support("org_someone_else");
      const foreign = await cancel(id, outsider);
      const missing = await cancel("doesnotexist1", outsider);
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toEqual(missing.json());
      expect((await loadRehearsal(db, s.orgId, id))?.state).toBe("queued");
    });
  });

  it("never creates an approval or a run", async () => {
    const s = await seed();
    await start(s, s.user);
    const grants = await db
      .select()
      .from(schema.approvalGrants)
      .where(eq(schema.approvalGrants.orgId, s.orgId));
    const runs = await db.select().from(schema.runs).where(eq(schema.runs.orgId, s.orgId));
    expect(grants).toHaveLength(0);
    expect(runs).toHaveLength(0);
  });

  describe("the report", () => {
    /** A completed rehearsal of revision 1 with its stored report. */
    async function finished(s: Seed) {
      const id = (await start(s, s.user)).json().rehearsal.rehearsalId as string;
      for (const [from, to] of [
        ["queued", "provisioning"],
        ["provisioning", "running"],
        ["running", "verifying"],
        ["verifying", "completed"],
      ] as const) {
        await transitionRehearsal(db, s.orgId, id, [from], to, { now: NOW });
      }
      const stored = await loadRehearsal(db, s.orgId, id);
      if (!stored) throw new Error("no rehearsal");
      const fixture = rehearsalReportFixture("passed");
      await saveRehearsalReport(
        db,
        s.orgId,
        {
          ...fixture,
          rehearsalId: id,
          plan: { orgId: s.orgId, planId: s.planId, revision: 1, planHash: s.hash },
          snapshot: { kind: "plan-evidence", digest: stored.rehearsal.snapshotDigest },
          policy: { id: stored.rehearsal.policyId, version: stored.rehearsal.policyVersion },
          finishedAt: NOW.toISOString(),
          steps: fixture.steps.map((st) => ({
            ...st,
            result: st.result && {
              ...st.result,
              rehearsalId: id,
              planHash: s.hash,
              operationKey: rehearsalOperationKey(id, `op_${st.actionId}`),
            },
          })),
        },
        NOW,
      );
      return id;
    }
    const read = (s: Seed, id: string, person: Caller, extra: object = {}, query = "") =>
      send(deps([person], extra), "GET", `/api/execution-rehearsals/${id}/report${query}`, {
        person,
      });

    it("is 404 until a report is stored, then returns it with nothing stale", async () => {
      const s = await seed();
      const id = (await start(s, s.user)).json().rehearsal.rehearsalId as string;
      const none = await read(s, id, s.reader);
      expect(none.statusCode).toBe(404);
      expect(none.json()).toEqual({ error: "report_not_found" });
    });

    it("reads staleness when asked, from the plan being viewed, and stores none of it", async () => {
      const s = await seed();
      const id = await finished(s);

      const current = await read(s, id, s.reader);
      expect(current.statusCode).toBe(200);
      expect(current.json().stale).toEqual([]);
      expect(current.json().report.rehearsalId).toBe(id);

      // A newer revision exists: the same stored row is now reported stale, and unchanged.
      const nextHash = await reviseOnce(s);
      const later = await read(s, id, s.reader);
      expect(later.json().stale).toEqual(
        expect.arrayContaining(["newer_revision", "different_hash"]),
      );
      expect(later.json().report).toEqual(current.json().report);
      // Looking at revision 1 explicitly: only the newer revision is a reason.
      const viewingOld = await read(s, id, s.reader, {}, "?revision=1");
      expect(viewingOld.json().stale).toEqual(["newer_revision"]);
      const viewingNew = await read(s, id, s.reader, {}, "?revision=2");
      expect(viewingNew.json().stale).toEqual(expect.arrayContaining(["different_hash"]));
      expect(nextHash).not.toBe(s.hash);
      expect((await read(s, id, s.reader, {}, "?revision=9")).statusCode).toBe(404);
    });

    it("marks a report stale when the build changed or a day passed", async () => {
      const s = await seed();
      const id = await finished(s);
      const report = (await read(s, id, s.reader)).json().report;

      const changed = await read(s, id, s.reader, {
        currentVersions: () => ({ ...report.versions, engine: "executor@2" }),
      });
      expect(changed.json().stale).toEqual(["versions_changed"]);

      const dayLater = await read(s, id, s.reader, {
        now: () => new Date(NOW.getTime() + 25 * 60 * 60 * 1000),
      });
      expect(dayLater.json().stale).toEqual(["expired"]);
    });
  });
});
