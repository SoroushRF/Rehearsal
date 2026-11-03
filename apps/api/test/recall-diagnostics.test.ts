import type { PrecedentBasis, PrecedentRecallDiagnostics } from "@rehearsal/contracts";
import { excludeActions, planHash } from "@rehearsal/core";
import { createDb, migrateDb, type PgBoss, schema, startQueue } from "@rehearsal/db";
import { PLANNER_JOB_ROUTES } from "@rehearsal/providers";
import { billingManifest, INCIDENT } from "@rehearsal/testkit";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { storePlan } from "../src/plans";
import { bearer, type Caller, fakeIam, support } from "./fake-iam";

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
    ["malformed", { recalled: "yes" }],
    [
      "for an area the basis didn't consult",
      { ...diagnostics, areas: [{ ...diagnostics.areas[0], area: "billing.other" }] },
    ],
  ])("keeps the plan but stores nothing when the diagnostics are %s", async (_, bad) => {
    const p = await planned({ recallDiagnostics: bad });
    expect(p.planHash).toBe(planHash(p.manifest));
    expect((await p.read()).json()).not.toHaveProperty("recallDiagnostics");
  });
});
