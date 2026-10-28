import { planHash } from "@rehearsal/core";
import { createDb, type Db, migrateDb, type PgBoss, PLAN_QUEUE, startQueue } from "@rehearsal/db";
import { PLANNER_JOB_ROUTES, PlanJob } from "@rehearsal/providers";
import { billingManifest, INCIDENT } from "@rehearsal/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { loadPlan, storePlan } from "../src/plans";
import { checkJobBasis, type RehearseDeps } from "../src/rehearse";
import { bearer, type Caller, fakeIam, member, support } from "./fake-iam";

const SECRET = "planner-secret";
const route = (path: string, id: string) => path.replace(":id", id);

describe("rehearse routes", () => {
  const sent: [string, unknown][] = [];
  const boss = {
    send: async (name: string, data: unknown) => {
      sent.push([name, data]);
      return "11111111-1111-4111-8111-111111111111";
    },
  } as unknown as PgBoss;
  const app = (me: Caller | null, extra: Partial<RehearseDeps> = {}) =>
    buildApp({
      webRoot: null,
      rehearse: {
        db: { select: () => ({ from: () => ({ where: async () => [] }) }) } as unknown as Db,
        boss,
        iam: fakeIam(me ? [me] : []),
        plannerSecret: SECRET,
        ...extra,
      },
    });
  const rehearse = (me: Caller | null, incident: string = INCIDENT.incident) =>
    app(me).inject({
      method: "POST",
      url: `/api/incidents/${incident}/rehearse`,
      headers: me ? bearer(me) : {},
    });

  it("only lets a signed-in person with rehearse permission spend model tokens", async () => {
    expect((await rehearse(null)).statusCode).toBe(401);
    expect((await rehearse(member("org_1"))).statusCode).toBe(403);
    expect((await rehearse(support("org_1", "user_1"), "INC-OTHER")).statusCode).toBe(404);
    expect(sent).toEqual([]);
  });

  it("seeds the org's own worlds before the plan job is queued (#330)", async () => {
    const order: string[] = [];
    const me = support("org_seed", "user_1");
    const seeding = app(me, {
      ensureSeeded: async (orgId) => {
        order.push(`seed ${orgId}`);
      },
      boss: {
        send: async () => {
          order.push("queued");
          return "22222222-2222-4222-8222-222222222222";
        },
      } as unknown as PgBoss,
    });
    const ok = await seeding.inject({
      method: "POST",
      url: `/api/incidents/${INCIDENT.incident}/rehearse`,
      headers: bearer(me),
    });
    expect(ok.statusCode).toBe(202);
    expect(order).toEqual(["seed org_seed", "queued"]);

    const before = sent.length;
    const down = await app(me, {
      ensureSeeded: async () => {
        throw new Error("era down");
      },
    }).inject({
      method: "POST",
      url: `/api/incidents/${INCIDENT.incident}/rehearse`,
      headers: bearer(me),
    });
    expect(down.statusCode).toBe(502);
    expect(down.json()).toEqual({ error: "world_unavailable" });
    expect(sent.length).toBe(before);
  });

  it("queues a plan job for the verified org and returns the plan ID it will have", async () => {
    const res = await rehearse(support("org_1", "user_1"));
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body).toMatchObject({ state: "queued", planId: expect.stringMatching(/^plan_/) });
    const [name, data] = sent.at(-1) ?? [];
    expect(name).toBe(PLAN_QUEUE);
    expect(PlanJob.parse(data)).toEqual({
      orgId: "org_1",
      incidentId: INCIDENT.incident,
      planId: body.planId,
      requestedBy: "user_1",
    });
  });

  it("puts the org's precedent registry on the job when precedents are wired", async () => {
    const digest = "d".repeat(64);
    const person = support("org_1", "user_1");
    const res = await app(person, {
      precedentRegistry: async (orgId) => {
        expect(orgId).toBe("org_1");
        return {
          active: new Map([["dup-refund", { version: 2, digest }]]),
          epochs: new Map([["billing.duplicate_charge", 3]]),
        };
      },
    }).inject({
      method: "POST",
      url: `/api/incidents/${INCIDENT.incident}/rehearse`,
      headers: bearer(person),
    });
    expect(res.statusCode).toBe(202);
    expect(PlanJob.parse(sent.at(-1)?.[1]).precedents).toEqual({
      active: [{ id: "dup-refund", version: 2, digest }],
      epochs: { "billing.duplicate_charge": 3 },
    });
  });

  it("keeps the internal routes for the planner worker's secret", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    for (const [secret, authorization] of [
      [SECRET, undefined],
      [SECRET, "Bearer wrong"],
      [undefined, `Bearer ${SECRET}`],
    ] as const) {
      const a = buildApp({
        webRoot: null,
        rehearse: { db: {} as Db, boss, iam: fakeIam([]), plannerSecret: secret },
      });
      const headers = authorization ? { authorization } : {};
      for (const url of [
        PLANNER_JOB_ROUTES.next,
        route(PLANNER_JOB_ROUTES.complete, id),
        route(PLANNER_JOB_ROUTES.fail, id),
      ]) {
        expect((await a.inject({ method: "POST", url, headers, payload: {} })).statusCode).toBe(
          401,
        );
      }
    }
  });

  it("says unavailable without a database", async () => {
    const a = buildApp({ webRoot: null });
    const res = await a.inject({
      method: "POST",
      url: `/api/incidents/${INCIDENT.incident}/rehearse`,
    });
    expect(res.statusCode).toBe(503);
  });
});

describe("a returned plan's precedent basis", () => {
  const AREA = "billing.duplicate_charge";
  const digest = "d".repeat(64);
  const citation = {
    id: "dup-refund",
    version: 2,
    digest,
    appliesTo: AREA,
    factIds: ["f1"],
    traceId: "t1",
  };
  const job = (precedents?: PlanJob["precedents"]): PlanJob => ({
    orgId: "org_1",
    incidentId: INCIDENT.incident,
    planId: "plan_1",
    requestedBy: "user_1",
    ...(precedents && { precedents }),
  });
  const registry = { active: [{ id: "dup-refund", version: 2, digest }], epochs: { [AREA]: 3 } };
  const plan = (precedentBasis?: unknown) =>
    ({
      ...billingManifest(),
      ...(precedentBasis !== undefined && { precedentBasis }),
    }) as Parameters<typeof checkJobBasis>[0];

  it("accepts a basis that cites what the job's registry has active, at its epochs", () => {
    expect(
      checkJobBasis(plan({ citations: [citation], epochs: { [AREA]: 3 } }), job(registry)),
    ).toBeNull();
    expect(checkJobBasis(plan(), job())).toBeNull();
    expect(checkJobBasis(plan(), job({ active: [], epochs: {} }))).toBeNull();
  });

  it("refuses a plan that skipped the org's precedents or cites ones it wasn't offered", () => {
    expect(checkJobBasis(plan(), job(registry))).toMatch(/no precedent basis/);
    expect(checkJobBasis(plan({ citations: [citation], epochs: { [AREA]: 3 } }), job())).toMatch(
      /didn't offer/,
    );
    expect(checkJobBasis(plan({ citations: [], epochs: {} }), job(registry))).toMatch(
      /areas differ/,
    );
  });

  it("refuses a citation the registry doesn't have active, or a moved epoch", () => {
    const withdrawn = { active: [], epochs: { [AREA]: 4 } };
    expect(
      checkJobBasis(plan({ citations: [citation], epochs: { [AREA]: 4 } }), job(withdrawn)),
    ).toMatch(/withdrawn/);
    expect(
      checkJobBasis(plan({ citations: [citation], epochs: { [AREA]: 2 } }), job(registry)),
    ).toMatch(/epoch_changed/);
  });
});

// Needs a real Postgres: `pnpm infra:up` then `DB_TESTS=1 pnpm --filter @rehearsal/api test`.
describe.skipIf(!process.env.DB_TESTS)("rehearse through the plan queue (real Postgres)", () => {
  const url = process.env.DATABASE_URL ?? "postgres://rehearsal:rehearsal@localhost:5432/rehearsal";
  const db = createDb(url);
  let boss: PgBoss;
  const worker = { authorization: `Bearer ${SECRET}` };

  beforeAll(async () => {
    await migrateDb(db);
    boss = await startQueue(url);
  });
  afterAll(async () => {
    await boss?.stop({ graceful: false });
  });

  const appFor = (me: Caller) =>
    buildApp({
      webRoot: null,
      rehearse: { db, boss, iam: fakeIam([me]), plannerSecret: SECRET },
    });

  /** Queue a rehearsal for a fresh org and claim it as the worker would. */
  async function claimed() {
    const me = support(`org_${crypto.randomUUID()}`, "user_1");
    const app = appFor(me);
    const queued = await app.inject({
      method: "POST",
      url: `/api/incidents/${INCIDENT.incident}/rehearse`,
      headers: bearer(me),
    });
    const { rehearsalId, planId } = queued.json();
    // Other runs may have left jobs behind; take ours, whatever is ahead of it.
    for (let i = 0; i < 50; i++) {
      const res = await app.inject({
        method: "POST",
        url: PLANNER_JOB_ROUTES.next,
        headers: worker,
      });
      expect(res.statusCode).toBe(200);
      if (res.json().id === rehearsalId) break;
    }
    const manifest = { ...billingManifest(planId), orgId: me.orgId };
    return { app, me, rehearsalId, planId, manifest };
  }
  const complete = (app: ReturnType<typeof appFor>, id: string, payload: object) =>
    app.inject({
      method: "POST",
      url: route(PLANNER_JOB_ROUTES.complete, id),
      headers: worker,
      payload,
    });
  const status = async (app: ReturnType<typeof appFor>, id: string, me: Caller) =>
    (
      await app.inject({
        method: "GET",
        url: `/api/rehearsals/${id}`,
        headers: bearer(me),
      })
    ).json();

  it("stores the returned manifest as revision 1 and reports it on the rehearsal", async () => {
    const { app, me, rehearsalId, planId, manifest } = await claimed();
    expect(await status(app, rehearsalId, me)).toMatchObject({ state: "planning", planId });

    const modelAttempts = [
      { turn: 1, attempt: 1, outcome: "rate_limit", reservedOutputTokens: 16000 },
      { turn: 1, attempt: 2, outcome: "succeeded", reservedOutputTokens: 16000 },
    ];
    const res = await complete(app, rehearsalId, {
      manifest,
      summary: "8 refunds.",
      stats: { turns: 1, toolCalls: 0, usage: {}, modelAttempts },
    });
    expect(res.statusCode).toBe(201);
    const { planHash } = res.json();
    const stored = await loadPlan(db, me.orgId, planId, 1);
    expect(stored).toMatchObject({ kind: "found", plan: { planHash } });
    expect(await status(app, rehearsalId, me)).toMatchObject({
      state: "stored",
      planHash,
      summary: "8 refunds.",
      modelAttempts,
    });

    // The job is finished; a second completion can't land anywhere.
    expect((await complete(app, rehearsalId, { manifest, summary: "again" })).statusCode).toBe(409);
    // Another org can't see it.
    const stranger = support("org_other");
    const other = appFor(stranger);
    expect(
      (
        await other.inject({
          method: "GET",
          url: `/api/rehearsals/${rehearsalId}`,
          headers: bearer(stranger),
        })
      ).statusCode,
    ).toBe(404);
  });

  it("finishes a job whose plan was stored before a crash, but not with another plan", async () => {
    // As if the first completion stored the plan and then failed before finishing the job.
    // JSONB hands the stored manifest back with its keys reordered.
    const { app, me, rehearsalId, manifest } = await claimed();
    const first = await storePlan(db, manifest);
    expect(first).not.toBeNull();

    const res = await complete(app, rehearsalId, { manifest, summary: "8 refunds." });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ planHash: first?.planHash });
    expect(await status(app, rehearsalId, me)).toMatchObject({
      state: "stored",
      planHash: first?.planHash,
    });

    // A different manifest under a plan ID that's already taken is still refused.
    const next = await claimed();
    expect(await storePlan(db, next.manifest)).not.toBeNull();
    const { versions } = next.manifest;
    const changed = {
      ...next.manifest,
      versions: { ...versions, planner: { ...versions.planner, promptVersion: "other" } },
    };
    const refused = await complete(next.app, next.rehearsalId, { manifest: changed, summary: "" });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ detail: "plan ID already holds another plan" });
    expect(await loadPlan(db, next.me.orgId, next.planId, 1)).toMatchObject({
      kind: "found",
      plan: { planHash: planHash(next.manifest) },
    });
  });

  it("rejects a manifest that doesn't match the job, and fails the run", async () => {
    const { app, me, rehearsalId, planId, manifest } = await claimed();
    const res = await complete(app, rehearsalId, {
      manifest: { ...manifest, orgId: "org_someone_else" },
      summary: "",
    });
    expect(res.statusCode).toBe(422);
    expect(await loadPlan(db, me.orgId, planId, 1)).toMatchObject({ kind: "not_found" });
    expect(await status(app, rehearsalId, me)).toMatchObject({
      // A failed run is retried once, with a fresh model run; the last failure stays visible.
      state: "retrying",
      error: { reason: "rejected_plan" },
    });
  });

  it("refuses a later revision or an empty plan from the planner", async () => {
    for (const change of [{ revision: 2, parentRevision: 1 }, { actions: [] }]) {
      const { app, rehearsalId, manifest } = await claimed();
      const res = await complete(app, rehearsalId, {
        manifest: { ...manifest, ...change },
        summary: "",
      });
      expect(res.statusCode).toBe(422);
    }
  });

  it("records the worker's failure reason on the rehearsal", async () => {
    const { app, me, rehearsalId } = await claimed();
    const res = await app.inject({
      method: "POST",
      url: route(PLANNER_JOB_ROUTES.fail, rehearsalId),
      headers: worker,
      payload: { reason: "turn_limit", message: "no finished plan after 40 turns" },
    });
    expect(res.statusCode).toBe(204);
    expect(await status(app, rehearsalId, me)).toMatchObject({
      state: "retrying",
      error: { reason: "turn_limit", message: "no finished plan after 40 turns" },
    });
  });
});
