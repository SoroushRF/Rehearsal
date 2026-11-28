import type { PlanManifest, Receipt } from "@rehearsal/contracts";
import { operationKey, planHash, type RepairRefresh } from "@rehearsal/core";
import {
  type Db,
  migrateDb,
  type PgBoss,
  PgJournal,
  PLAN_QUEUE,
  schema,
  startQueue,
} from "@rehearsal/db";
import { PLANNER_JOB_ROUTES, PlanJob } from "@rehearsal/providers";
import { billingManifest, INCIDENT } from "@rehearsal/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedTestDatabase } from "../../../packages/db/test/isolated-db";
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
  const database = isolatedTestDatabase();
  const { db, url } = database;
  let boss: PgBoss;
  const worker = { authorization: `Bearer ${SECRET}` };

  beforeAll(async () => {
    await database.create();
    await migrateDb(db);
    boss = await startQueue(url);
  });
  afterAll(async () => {
    await boss?.stop({ graceful: false });
    await database.drop();
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
    const claimed = await app.inject({
      method: "POST",
      url: PLANNER_JOB_ROUTES.next,
      headers: worker,
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json().id).toBe(rehearsalId);
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

  it.each([
    {
      modelAttempts: [
        { turn: 1, attempt: 1, outcome: "future_outcome", reservedOutputTokens: 16000 },
      ],
    },
    {
      modelAttempts: Array.from({ length: 45 }, (_, n) => ({
        turn: n + 1,
        attempt: 1,
        outcome: "succeeded",
        reservedOutputTokens: 16000,
      })),
    },
  ])(
    "keeps a valid completion when optional diagnostics cannot be parsed",
    async ({ modelAttempts }) => {
      const { app, me, rehearsalId, manifest } = await claimed();
      const res = await complete(app, rehearsalId, {
        manifest,
        summary: "8 refunds.",
        stats: { turns: 1, toolCalls: 0, usage: {}, modelAttempts },
      });
      expect(res.statusCode).toBe(201);
      const result = await status(app, rehearsalId, me);
      expect(result.state).toBe("stored");
      expect(result.modelAttempts).toBeUndefined();
    },
  );

  it("keeps a failure report when optional diagnostics cannot be parsed", async () => {
    const { app, me, rehearsalId } = await claimed();
    const res = await app.inject({
      method: "POST",
      url: route(PLANNER_JOB_ROUTES.fail, rehearsalId),
      headers: worker,
      payload: { reason: "model_rate_limit", message: "quota", modelAttempts: [{ future: true }] },
    });
    expect(res.statusCode).toBe(204);
    const result = await status(app, rehearsalId, me);
    expect(result).toMatchObject({
      state: "retrying",
      error: { reason: "model_rate_limit", message: "quota" },
    });
    expect(result.modelAttempts).toBeUndefined();
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

const PHANTOM = "ch_fixture_001_dup";

// Its own database isolates both plan jobs and world locks from the other suites.
describe.skipIf(!process.env.DB_TESTS)("repair a held run (T1.37, real Postgres)", () => {
  const database = isolatedTestDatabase();
  const { db, url } = database;
  let boss: PgBoss;
  const worker = { authorization: `Bearer ${SECRET}` };

  beforeAll(async () => {
    await database.create();
    await migrateDb(db);
    boss = await startQueue(url);
  });
  afterAll(async () => {
    await boss?.stop({ graceful: false });
    await database.drop();
  });

  const refreshed: [string, RepairRefresh[]][] = [];
  const appFor = (me: Caller, refresh = true) =>
    buildApp({
      webRoot: null,
      rehearse: {
        db,
        boss,
        iam: fakeIam([me]),
        plannerSecret: SECRET,
        ...(refresh && {
          refreshPlanning: async (orgId: string, records: RepairRefresh[]) => {
            refreshed.push([orgId, records]);
            return records.map((r) => r.id);
          },
        }),
      },
    });

  const receipt = (
    hash: string,
    actionId: string,
    outcome: Receipt["outcome"],
    holdReason: Receipt["holdReason"] = null,
  ): Receipt => ({
    id: `rcpt_${crypto.randomUUID()}`,
    actionId,
    planHash: hash,
    approvalId: "grant_1",
    outcome,
    providerRef: null,
    observedEffect: {},
    protection: "native_guard_with_documented_limits",
    holdReason,
    limitations: [],
    recordedAt: new Date().toISOString(),
  });

  /**
   * A stored revision 1 whose run ended like the phantom demo: case 001's refund held on a new
   * charge and its note skipped; case 001's priority patch and all of case 002 confirmed.
   */
  async function heldRun(runState = "partial") {
    const me = support(`org_${crypto.randomUUID()}`, "user_1");
    const manifest: PlanManifest = {
      ...billingManifest(`plan_${crypto.randomUUID()}`),
      orgId: me.orgId,
    };
    await storePlan(db, manifest);
    const hash = planHash(manifest);
    const runId = `run_${crypto.randomUUID()}`;
    await db.insert(schema.runs).values({
      id: runId,
      orgId: me.orgId,
      planId: manifest.planId,
      revision: 1,
      planHash: hash,
      approvalId: "grant_1",
      requestedBy: "user_1",
      state: runState,
    });
    const journal = new PgJournal(db, me.orgId);
    for (const r of [
      receipt(hash, "refund_001", "held", {
        kind: "query_membership_changed",
        queryObservationId: "q_charges_001",
        added: [PHANTOM],
        removed: [],
      }),
      receipt(hash, "patch_001", "confirmed"),
      receipt(hash, "note_001", "skipped_dependency", {
        kind: "predecessor_not_confirmed",
        stepId: "refund_001",
      }),
      receipt(hash, "refund_002", "confirmed"),
      receipt(hash, "patch_002", "confirmed"),
      receipt(hash, "note_002", "confirmed"),
    ]) {
      await journal.recordReceipt(r);
    }
    return { me, manifest, hash, runId };
  }

  const repair = (app: ReturnType<typeof appFor>, me: Caller, planId: string, payload: object) =>
    app.inject({
      method: "POST",
      url: `/api/plans/${planId}/repair`,
      headers: bearer(me),
      payload,
    });

  /** Claim the queued job as the planner worker would. */
  async function claim(app: ReturnType<typeof appFor>, jobId: string) {
    for (let i = 0; i < 50; i++) {
      const res = await app.inject({
        method: "POST",
        url: PLANNER_JOB_ROUTES.next,
        headers: worker,
      });
      expect(res.statusCode).toBe(200);
      if (res.json().id === jobId) return PlanJob.parse(res.json().data);
    }
    throw new Error("job never claimed");
  }

  it("refreshes the copy, queues a job for the open case, and stores the repair as revision 2", async () => {
    const { me, manifest, hash, runId } = await heldRun();
    const app = appFor(me);
    const res = await repair(app, me, manifest.planId, { runId, revision: 1, planHash: hash });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      planId: manifest.planId,
      baseRevision: 1,
      revision: 2,
      state: "queued",
      openCases: ["case_001"],
      refreshed: [PHANTOM],
    });
    expect(res.json().kept.sort()).toEqual(["note_002", "patch_001", "patch_002", "refund_002"]);
    expect(refreshed.at(-1)).toEqual([
      me.orgId,
      [{ vendor: "stripe", kind: "charge", id: PHANTOM }],
    ]);

    const job = await claim(app, res.json().rehearsalId);
    expect(job.repair).toMatchObject({ basePlanHash: hash, runId, openCases: ["case_001"] });
    expect(job.repair?.stopped).toContainEqual({
      id: "refund_001",
      why: `held: ${PHANTOM} newly matched its query`,
    });

    const complete = (m: PlanManifest) =>
      app.inject({
        method: "POST",
        url: route(PLANNER_JOB_ROUTES.complete, res.json().rehearsalId),
        headers: worker,
        payload: { manifest: m, summary: "repaired" },
      });
    // A repair that edits a kept step is refused, and the job fails rather than storing it.
    const r2 = structuredClone({ ...manifest, revision: 2, parentRevision: 1 });
    const edited = structuredClone(r2);
    const kept = edited.actions.find((a) => a.id === "refund_002");
    if (kept) kept.rationale = "edited after the fact";
    const refused = await complete(edited);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().detail).toMatch(/kept step refund_002 changed/);
    expect((await loadPlan(db, me.orgId, manifest.planId, 2)).kind).toBe("not_found");
  });

  it("stores a valid repair as the next revision with its own hash", async () => {
    const { me, manifest, hash, runId } = await heldRun();
    const app = appFor(me);
    const res = await repair(app, me, manifest.planId, { runId, revision: 1, planHash: hash });
    const jobId = res.json().rehearsalId;
    await claim(app, jobId);
    const r2 = structuredClone({ ...manifest, revision: 2, parentRevision: 1 });
    const done = await app.inject({
      method: "POST",
      url: route(PLANNER_JOB_ROUTES.complete, jobId),
      headers: worker,
      payload: { manifest: r2, summary: "repaired" },
    });
    expect(done.statusCode).toBe(201);
    expect(done.json()).toMatchObject({ planId: manifest.planId, revision: 2 });
    expect(done.json().planHash).not.toBe(hash);
    const stored = await loadPlan(db, me.orgId, manifest.planId);
    expect(stored).toMatchObject({ kind: "found", latestRevision: 2 });
    const status = await app.inject({
      method: "GET",
      url: `/api/rehearsals/${jobId}`,
      headers: bearer(me),
    });
    expect(status.json()).toMatchObject({ state: "stored", revision: 2 });

    // Revision 1 is no longer the latest: repairing it again is refused.
    const again = await repair(app, me, manifest.planId, { runId, revision: 1, planHash: hash });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: "stale_revision", latestRevision: 2 });
  });

  it("refuses what a repair can't make safe", async () => {
    const held = await heldRun();
    const app = appFor(held.me);
    const body = { runId: held.runId, revision: 1, planHash: held.hash };

    // The hash must be the stored revision's; the run must be one of this revision's.
    expect(
      (await repair(app, held.me, held.manifest.planId, { ...body, planHash: "0".repeat(64) }))
        .statusCode,
    ).toBe(409);
    expect(
      (await repair(app, held.me, held.manifest.planId, { ...body, runId: "run_other" }))
        .statusCode,
    ).toBe(404);
    // Strict: a body carrying steps is refused.
    expect(
      (await repair(app, held.me, held.manifest.planId, { ...body, actions: [] })).statusCode,
    ).toBe(400);
    // A member can't spend model tokens; another org doesn't see the plan.
    const m = member(held.me.orgId);
    expect((await repair(appFor(m), m, held.manifest.planId, body)).statusCode).toBe(403);
    const stranger = support(`org_${crypto.randomUUID()}`);
    expect((await repair(appFor(stranger), stranger, held.manifest.planId, body)).statusCode).toBe(
      404,
    );
    // Without a refresher, a hold that needs the copy refreshed can't be repaired.
    const noRefresh = await repair(appFor(held.me, false), held.me, held.manifest.planId, body);
    expect(noRefresh.json()).toMatchObject({ error: "not_repairable" });

    // A run still applying can settle more steps.
    const active = await heldRun("applying");
    expect(
      (
        await repair(appFor(active.me), active.me, active.manifest.planId, {
          runId: active.runId,
          revision: 1,
          planHash: active.hash,
        })
      ).json(),
    ).toMatchObject({ error: "work_in_progress" });

    // A send whose outcome is unknown is reconciled by resuming the run, never replanned around.
    const unknown = await heldRun();
    const refund = unknown.manifest.actions.find((a) => a.id === "refund_001");
    if (!refund) throw new Error("no refund");
    await db.insert(schema.stepAttempts).values({
      id: `att_${crypto.randomUUID()}`,
      orgId: unknown.me.orgId,
      planHash: unknown.hash,
      actionId: "refund_001",
      operationKey: operationKey(unknown.me.orgId, unknown.manifest.planId, refund),
      attemptNo: 1,
      state: "unknown_outcome",
      request: {},
      preparedAt: new Date(),
    });
    const inFlight = await repair(appFor(unknown.me), unknown.me, unknown.manifest.planId, {
      runId: unknown.runId,
      revision: 1,
      planHash: unknown.hash,
    });
    expect(inFlight.statusCode).toBe(409);
    expect(inFlight.json()).toMatchObject({
      error: "not_repairable",
      detail: expect.stringMatching(/refund_001 has a send in flight/),
    });
  });
});
