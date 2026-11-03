import type { PrecedentBasis, PrecedentRecallDiagnostics } from "@rehearsal/contracts";
import { excludeActions, planHash } from "@rehearsal/core";
import { createDb, migrateDb, type PgBoss, PLAN_QUEUE, schema, startQueue } from "@rehearsal/db";
import { PLANNER_JOB_ROUTES, type PlanJob } from "@rehearsal/providers";
import { billingManifest, INCIDENT } from "@rehearsal/testkit";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app";
import { storePlan } from "../src/plans";
import { recallDiagnosticsProblem } from "../src/rehearse";
import { bearer, type Caller, fakeIam, support } from "./fake-iam";

// The diagnostics table's reads and writes pass through unless a test makes them fail.
const failing = vi.hoisted(() => ({ record: false, load: false }));
vi.mock("@rehearsal/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@rehearsal/db")>();
  return {
    ...real,
    recordRecallDiagnostics: (...args: Parameters<typeof real.recordRecallDiagnostics>) => {
      if (failing.record) throw new Error("diagnostics table unavailable");
      return real.recordRecallDiagnostics(...args);
    },
    loadRecallDiagnostics: (...args: Parameters<typeof real.loadRecallDiagnostics>) => {
      if (failing.load) throw new Error("diagnostics table unavailable");
      return real.loadRecallDiagnostics(...args);
    },
  };
});

const SECRET = "planner-secret";
const AREA = "billing.duplicate_charge";
const OTHER = "billing.refund_window";
const digest = "d".repeat(64);
const basis: PrecedentBasis = {
  citations: [
    { id: "dup-refund", version: 2, digest, appliesTo: AREA, factIds: ["f1"], traceId: "trace_1" },
  ],
  epochs: { [AREA]: 3, [OTHER]: 1 },
};
const diagnostics: PrecedentRecallDiagnostics = {
  recalled: true,
  areas: [
    {
      area: AREA,
      query: AREA,
      traceId: "trace_1",
      hits: [{ id: "dup-refund", version: 2, factIds: ["f1"], hitIds: ["h1"] }],
      dropped: [{ id: "old-rule", reason: "registry has version 3", stage: "registry" }],
    },
    {
      area: OTHER,
      query: OTHER,
      traceId: "trace_2",
      hits: [],
      dropped: [{ id: "gone-rule", reason: "withdrawn at v1", stage: "recall" }],
    },
  ],
};

/** The job the API queued: the registry's active precedent, so recall was asked. */
const job = (active: { id: string; version: number }[] = [{ id: "dup-refund", version: 2 }]) =>
  ({
    orgId: "org_1",
    incidentId: INCIDENT.incident,
    planId: "plan_1",
    requestedBy: "user_1",
    precedents: {
      active: active.map((a) => ({ ...a, digest })),
      epochs: basis.epochs,
    },
  }) as unknown as PlanJob;
const [found, quiet] = diagnostics.areas as [
  PrecedentRecallDiagnostics["areas"][number],
  PrecedentRecallDiagnostics["areas"][number],
];

/** Each way the worker's account can disagree with the job and the basis it produced. */
const disagreeing: [string, PrecedentRecallDiagnostics, RegExp][] = [
  ["says recall wasn't asked", { recalled: false, areas: [] }, /recall wasn't asked/],
  ["names an area twice", { ...diagnostics, areas: [found, quiet, found] }, /area twice/],
  ["leaves out an area the basis consulted", { ...diagnostics, areas: [found] }, /areas differ/],
  [
    "adds an area the basis didn't consult",
    { ...diagnostics, areas: [found, quiet, { ...quiet, area: "billing.other" }] },
    /areas differ/,
  ],
  [
    "lists a hit twice in one area",
    { ...diagnostics, areas: [{ ...found, hits: [...found.hits, ...found.hits] }, quiet] },
    /hit twice in billing.duplicate_charge/,
  ],
  [
    "doesn't list the cited precedent among the hits",
    { ...diagnostics, areas: [{ ...found, hits: [] }, quiet] },
    /cited dup-refund v2 is not among the hits/,
  ],
  [
    "lists the cited precedent at another version",
    {
      ...diagnostics,
      areas: [
        { ...found, hits: [{ id: "dup-refund", version: 1, factIds: ["f1"], hitIds: ["h1"] }] },
        quiet,
      ],
    },
    /cited dup-refund v2 is not among the hits/,
  ],
];

describe("recallDiagnosticsProblem (T1.54)", () => {
  it("accepts an account that agrees with the job and the basis", () => {
    expect(recallDiagnosticsProblem(diagnostics, basis, job())).toBeNull();
  });

  it.each(disagreeing)("refuses one that %s", (_, bad, problem) => {
    expect(recallDiagnosticsProblem(bad, basis, job())).toMatch(problem);
  });

  it("accepts recall not asked only when nothing was active, with no areas", () => {
    const none = { citations: [], epochs: basis.epochs };
    expect(recallDiagnosticsProblem({ recalled: false, areas: [] }, none, job([]))).toBeNull();
    expect(recallDiagnosticsProblem(diagnostics, none, job([]))).toMatch(
      /recall was asked, but the job had nothing active/,
    );
    expect(recallDiagnosticsProblem({ recalled: false, areas: [found] }, none, job([]))).toMatch(
      /areas differ/,
    );
  });

  it("finds a citation under the area whose query found it, by its trace", () => {
    // Recall for one area can find a precedent that applies to another; the citation carries
    // the trace of the query that found it.
    const moved: PrecedentRecallDiagnostics = {
      recalled: true,
      areas: [
        { ...found, traceId: "trace_0", hits: [] },
        { ...quiet, traceId: "trace_1", hits: found.hits },
      ],
    };
    const tracedElsewhere = { ...basis, citations: basis.citations.map((c) => ({ ...c })) };
    expect(recallDiagnosticsProblem(moved, tracedElsewhere, job())).toBeNull();
    const untraced = {
      ...basis,
      citations: basis.citations.map((c) => ({ ...c, traceId: null })),
    };
    expect(recallDiagnosticsProblem(moved, untraced, job())).toMatch(/not among the hits/);
  });
});

// Needs a real Postgres: `pnpm infra:up` then `DB_TESTS=1 pnpm --filter @rehearsal/api test`.
describe.skipIf(!process.env.DB_TESTS)("recall diagnostics beside the plan (T1.54)", () => {
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
  afterEach(() => {
    failing.record = false;
    failing.load = false;
  });

  const appFor = (me: Caller) => {
    const iam = fakeIam([me]);
    return buildApp({
      webRoot: null,
      plans: { db, iam },
      rehearse: {
        db,
        boss,
        iam,
        plannerSecret: SECRET,
        precedentRegistry: async () => ({
          active: new Map([["dup-refund", { version: 2, digest }]]),
          epochs: new Map([
            [AREA, 3],
            [OTHER, 1],
          ]),
        }),
      },
    });
  };

  /** Queue a rehearsal for a fresh org, claim it as the worker would, and complete it. */
  async function planned(stats?: object) {
    const me = support(`org_${crypto.randomUUID()}`, "user_1");
    const app = appFor(me);
    const queued = await app.inject({
      method: "POST",
      url: `/api/incidents/${INCIDENT.incident}/rehearse`,
      headers: bearer(me),
    });
    const { rehearsalId, planId } = queued.json();
    for (let i = 0; i < 50; i++) {
      const res = await app.inject({
        method: "POST",
        url: PLANNER_JOB_ROUTES.next,
        headers: worker,
      });
      if (res.json().id === rehearsalId) break;
    }
    const manifest = { ...billingManifest(planId), orgId: me.orgId, precedentBasis: basis };
    const done = await app.inject({
      method: "POST",
      url: PLANNER_JOB_ROUTES.complete.replace(":id", rehearsalId),
      headers: worker,
      payload: {
        manifest,
        summary: "8 refunds.",
        ...(stats && { stats: { turns: 1, toolCalls: 0, usage: {}, ...stats } }),
      },
    });
    expect(done.statusCode).toBe(201);
    const read = (revision?: number) =>
      app.inject({
        method: "GET",
        url: `/api/plans/${planId}${revision ? `?revision=${revision}` : ""}`,
        headers: bearer(me),
      });
    return { app, me, rehearsalId, planId, manifest, planHash: done.json().planHash, read };
  }

  /** Queue the same job again and complete it with the same manifest: the repeat path. */
  async function completeAgain(p: Awaited<ReturnType<typeof planned>>, stats?: object) {
    const original = await boss.getJobById<PlanJob>(PLAN_QUEUE, p.rehearsalId);
    const id = await boss.send(PLAN_QUEUE, original?.data as object);
    for (let i = 0; i < 50; i++) {
      const res = await p.app.inject({
        method: "POST",
        url: PLANNER_JOB_ROUTES.next,
        headers: worker,
      });
      if (res.json().id === id) break;
    }
    return p.app.inject({
      method: "POST",
      url: PLANNER_JOB_ROUTES.complete.replace(":id", String(id)),
      headers: worker,
      payload: {
        manifest: p.manifest,
        summary: "8 refunds.",
        ...(stats && { stats: { turns: 1, toolCalls: 0, usage: {}, ...stats } }),
      },
    });
  }

  const otherDiagnostics: PrecedentRecallDiagnostics = {
    ...diagnostics,
    areas: [
      { ...found, dropped: [] },
      {
        ...quiet,
        traceId: "trace_9",
        dropped: [{ id: "new-rule", reason: "not active in the registry", stage: "registry" }],
      },
    ],
  };

  it("stores the same plan, by hash and content, with diagnostics, without, or with others", async () => {
    // With, then without: the second completion is the same plan, and the first account stays.
    const p = await planned({ recallDiagnostics: diagnostics });
    const first = (await p.read()).json();
    const again = await completeAgain(p);
    expect(again.statusCode).toBe(201);
    expect(again.json().planHash).toBe(p.planHash);
    const second = (await p.read()).json();
    expect(second.planHash).toBe(first.planHash);
    expect(second.manifest).toEqual(first.manifest);
    expect(second.recallDiagnostics.diagnostics).toEqual(diagnostics);

    // Without, then with different ones: still the same plan, which now has an account.
    const q = await planned();
    const before = (await q.read()).json();
    const later = await completeAgain(q, { recallDiagnostics: otherDiagnostics });
    expect(later.statusCode).toBe(201);
    expect(later.json().planHash).toBe(q.planHash);
    const after = (await q.read()).json();
    expect(after.planHash).toBe(before.planHash);
    expect(after.manifest).toEqual(before.manifest);
    expect(after.recallDiagnostics.diagnostics).toEqual(otherDiagnostics);

    expect(p.planHash).toBe(planHash(p.manifest));
    expect(q.planHash).toBe(planHash(q.manifest));
  });

  it("stores the plan when the diagnostics can't be written, and serves it without them", async () => {
    failing.record = true;
    const p = await planned({ recallDiagnostics: diagnostics });
    expect(p.planHash).toBe(planHash(p.manifest));
    const res = await p.read();
    expect(res.statusCode).toBe(200);
    expect(res.json().planHash).toBe(p.planHash);
    expect(res.json()).not.toHaveProperty("recallDiagnostics");
  });

  it("serves the plan without diagnostics when they can't be read", async () => {
    const p = await planned({ recallDiagnostics: diagnostics });
    expect((await p.read()).json().recallDiagnostics).toBeDefined();
    failing.load = true;
    const res = await p.read();
    expect(res.statusCode).toBe(200);
    expect(res.json().planHash).toBe(p.planHash);
    expect(res.json().manifest.planId).toBe(p.planId);
    expect(res.json()).not.toHaveProperty("recallDiagnostics");
  });

  it("stores them beside revision 1 and serves them with the plan, with the hash unchanged", async () => {
    const p = await planned({ recallDiagnostics: diagnostics });
    // The hash is the manifest's own: what it would be with no diagnostics at all.
    expect(p.planHash).toBe(planHash(p.manifest));
    const res = await p.read();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.planHash).toBe(p.planHash);
    expect(body.recallDiagnostics).toEqual({
      revision: 1,
      recordedAt: expect.any(String),
      diagnostics,
    });
    expect(JSON.stringify(body.manifest)).not.toContain("hitIds");
    const [row] = await db
      .select()
      .from(schema.planVersions)
      .where(eq(schema.planVersions.planId, p.planId));
    expect(JSON.stringify(row?.manifest)).not.toContain("hitIds");

    // They aren't copied into the job's output.
    const status = await p.app.inject({
      method: "GET",
      url: `/api/rehearsals/${p.rehearsalId}`,
      headers: bearer(p.me),
    });
    expect(status.json()).toMatchObject({ state: "stored", planHash: p.planHash });
    expect(status.json().recallDiagnostics).toBeUndefined();
  });

  it("serves them for a reviewer's revision with the same basis, and not for a changed basis", async () => {
    const p = await planned({ recallDiagnostics: diagnostics });
    const r2 = excludeActions(p.manifest, ["note_001"]);
    expect(await storePlan(db, r2)).not.toBeNull();
    expect((await p.read(2)).json().recallDiagnostics).toMatchObject({ revision: 1 });
    const r3 = excludeActions({ ...r2, precedentBasis: { citations: [], epochs: basis.epochs } }, [
      "note_002",
    ]);
    expect(await storePlan(db, r3)).not.toBeNull();
    const res = await p.read(3);
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty("recallDiagnostics");
  });

  it("serves a plan with none recorded exactly as before", async () => {
    const p = await planned();
    const body = (await p.read()).json();
    expect(body).not.toHaveProperty("recallDiagnostics");
    expect(body.planHash).toBe(planHash(p.manifest));
  });

  it.each([
    ["are malformed", { recalled: "yes" }],
    ...disagreeing.map(([what, bad]) => [what, bad] as [string, object]),
  ])("keeps the plan but stores nothing when the diagnostics %s", async (_, bad) => {
    const p = await planned({ recallDiagnostics: bad });
    expect(p.planHash).toBe(planHash(p.manifest));
    expect((await p.read()).json()).not.toHaveProperty("recallDiagnostics");
  });
});
