import type { PlanManifest } from "@rehearsal/contracts";
import { type BillingPolicy, type BillingPolicyV1, fingerprint } from "@rehearsal/core";
import {
  createDb,
  loadRegistry,
  migrateDb,
  type PgBoss,
  PRECEDENT_QUEUE,
  schema,
  startQueue,
} from "@rehearsal/db";
import {
  AgentMemoryClient,
  AgentMemoryError,
  memoryConfigFromEnv,
  memoryKeyGrants,
  PrecedentRecord,
  precedentDigest,
  precedentScope,
} from "@rehearsal/memory";
import {
  plannerJobsClient,
  STRIPE_CHARGE_PROJECTION,
  stripeChargeProjection,
  ZENDESK_TICKET_PROJECTION,
} from "@rehearsal/providers";
import { INCIDENT, incidentRecords } from "@rehearsal/testkit";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeAgentMemory } from "../../../packages/memory/test/fake-agent-memory";
import {
  clientWithKey,
  eraseScope,
  LIVE,
  liveConfig,
  mintKey,
  revokeKey,
  runId,
} from "../../../packages/memory/test/live";
import policyV1 from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import policyV2 from "../../../scenarios/billing/policy.v2.json" with { type: "json" };
import policyV3 from "../../../scenarios/billing/policy.v3.json" with { type: "json" };
import { plannerCredentialViolations } from "../../planner-worker/src/credentials";
import { handlePlanJob, type PlanJobContext } from "../../planner-worker/src/job";
import { recallersFromEnv } from "../../planner-worker/src/precedents";
import { buildApp } from "../src/app";
import { loadPlan } from "../src/plans";
import { publisherFromEnv, syncPrecedent } from "../src/precedent-sync";
import { bearer, type Caller, fakeIam, finance, support } from "./fake-iam";

/**
 * T1.50 (#366): the precedent chain through the app, not the memory library. A finance lead
 * promotes a precedent from a completed run; the API's sync publishes it with the write key and
 * only then activates it; a rehearsal queues a plan job carrying the org's registry; the planner
 * worker claims it over HTTP, recalls in the org's scope with its read-only key and hands back a
 * plan that cites the precedent by version, digest, fact IDs and trace ID; withdrawing the
 * precedent then refuses approval, and a replan drops the copy Agent Memory still holds.
 *
 * Real: Postgres and pg-boss (a fresh database of its own, so no other test's jobs are claimed),
 * the API's routes, queued jobs and sync handler, and the planner worker's credential check, job
 * handler, job client and recall setup.
 * Stand-ins: IAM (the real rule file over registered people), the model (a fixed script) and the
 * planning world's reads (testkit records). Agent Memory is the in-memory fake unless
 * MEMORY_GATE=1, which runs against the hosted service in a throwaway scope it erases afterwards.
 */

const URL_ = process.env.DATABASE_URL ?? "postgres://rehearsal:rehearsal@localhost:5432/rehearsal";
const GATE_DB = "rehearsal_precedent_gate";
const gateUrl = (() => {
  const u = new URL(URL_);
  u.pathname = `/${GATE_DB}`;
  return u.toString();
})();
const SECRET = "planner-gate-secret";
// Hosted recall takes 5–10 s a query (docs/agent-memory.md); a plan recalls once per area.
const TIMEOUT = LIVE ? 180_000 : 30_000;
const POLICIES = [policyV1, policyV2, policyV3] as unknown as BillingPolicy[];
const AREA = "billing.duplicate_charge";
const ID = "dup-refund";
const content = {
  id: ID,
  appliesTo: AREA,
  statement: "A duplicate charge found within 30 days is refunded in full to the original card.",
  conditions: ["same amount, customer and invoice"],
  exceptions: ["charges at or above 100.00 CAD go to finance first"],
  effectiveFrom: "2026-09-01",
  effectiveUntil: null,
};
/** A second precedent in the same area, which stays active when the first is withdrawn. */
const ID_2 = "dup-small-charge";
const content2 = {
  ...content,
  id: ID_2,
  statement: "A duplicate charge under 20.00 CAD is refunded without a ticket note.",
};

const records = incidentRecords();

// The planner's types, through its worker (apps/api doesn't depend on @rehearsal/planner).
type PlanningReader = PlanJobContext["readers"]["stripe"];
type MessagesClient = PlanJobContext["client"];
type Message = Awaited<ReturnType<MessagesClient["create"]>>;

/** Planning-world Stripe reads over the seeded charges (the planner's tools); Zendesk unused. */
const stripe: PlanningReader = {
  vendor: "stripe",
  async observe(entity) {
    const c = records.stripe.charges.find((x) => String(x.id) === entity.id);
    if (!c) throw new Error("404");
    const projection = stripeChargeProjection(c);
    return {
      id: `obs_${entity.id}`,
      world: "planning",
      entity,
      projectionVersion: STRIPE_CHARGE_PROJECTION,
      projection,
      fingerprint: fingerprint(projection),
      capturedAt: new Date().toISOString(),
    };
  },
  async query(predicate, cutoff) {
    if (predicate.kind !== "stripe.charges.byCustomerInWindow") throw new Error("unsupported");
    const hits = records.stripe.charges.filter((c) => c.customer === predicate.customerId);
    const projections = Object.fromEntries(
      hits.map((c) => [String(c.id), stripeChargeProjection(c)]),
    );
    const matchingIds = Object.keys(projections).sort();
    return {
      id: "q_gate",
      world: "planning",
      vendor: "stripe",
      predicate,
      cutoff,
      complete: true,
      matchingIds,
      projectionVersion: STRIPE_CHARGE_PROJECTION,
      projections,
      fingerprint: fingerprint({ matchingIds, projections }),
      capturedAt: new Date().toISOString(),
    };
  },
};
const zendesk: PlanningReader = {
  vendor: "zendesk",
  observe: async () => {
    throw new Error("not used");
  },
  query: async () => {
    throw new Error("not used");
  },
};

/** The model: examine every customer, refund every duplicate, finish. */
function scriptedModel(): MessagesClient {
  const reply = (calls: [string, unknown][]) =>
    ({
      id: "msg_gate",
      type: "message",
      role: "assistant",
      model: "scripted",
      content: [
        ...(calls.length === 0 ? [{ type: "text", text: "Refunded the duplicates." }] : []),
        ...calls.map(([name, input], i) => ({ type: "tool_use", id: `tu_${i}`, name, input })),
      ],
      stop_reason: calls.length > 0 ? "tool_use" : "end_turn",
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    }) as unknown as Message;
  const turns = [
    reply(records.cases.map((c) => ["list_customer_charges", { customerId: c.customerId }])),
    reply(
      records.cases
        .filter((c) => c.kind === "duplicate")
        .map((c) => [
          "propose_duplicate_refund",
          {
            chargeId: c.chargeIds[1],
            duplicateOfChargeId: c.chargeIds[0],
            rationale: "Charged twice for one invoice.",
          },
        ]),
    ),
    reply([]),
  ];
  let n = 0;
  return {
    async create() {
      const next = turns[n++];
      if (!next) throw new Error("script ran out");
      return next;
    },
  };
}

describe.skipIf(!process.env.DB_TESTS)("precedent gate through the app (T1.50)", () => {
  const run = runId();
  const orgId = `org_gate_${run}`;
  const fin = finance(orgId);
  const sup = support(orgId);
  const iam = fakeIam([fin, sup]);

  // Agent Memory: the fake by default, the hosted service with MEMORY_GATE=1.
  const base = LIVE ? `rehearsal/test/app-gate-${run}` : "rehearsal/precedents";
  const orgScope = precedentScope(base, orgId);
  const fake = new FakeAgentMemory();
  const memoryFetch = LIVE ? undefined : fake.fetch;
  const keyNames = { api: `app-gate-api-${run}`, planner: `app-gate-planner-${run}` };
  let apiEnv: Record<string, string>;
  let plannerEnv: Record<string, string>;

  let db: ReturnType<typeof createDb>;
  let boss: PgBoss;
  let app: ReturnType<typeof buildApp>;
  let apiUrl: string;
  const log: string[] = [];

  beforeAll(async () => {
    // A fresh database of its own: its plan and sync queues hold only this run's jobs.
    const admin = createDb(URL_);
    await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${GATE_DB} WITH (FORCE)`));
    await admin.execute(sql.raw(`CREATE DATABASE ${GATE_DB}`));
    await admin.$client.end();
    db = createDb(gateUrl);
    await migrateDb(db);
    boss = await startQueue(gateUrl);

    if (LIVE) {
      const { url, context } = liveConfig();
      await clientWithKey(liveConfig().apiKey).registerScope(base);
      const grants = memoryKeyGrants(base);
      const shared = { SURREAL_AGENT_MEMORY_URL: url, SURREAL_AGENT_MEMORY_CONTEXT: context };
      apiEnv = {
        ...shared,
        SURREAL_AGENT_MEMORY_WRITE_KEY: await mintKey(keyNames.api, grants.api),
        SURREAL_AGENT_MEMORY_SCOPE: base,
      };
      plannerEnv = {
        ...shared,
        SURREAL_AGENT_MEMORY_READ_KEY: await mintKey(keyNames.planner, grants.planner),
        SURREAL_AGENT_MEMORY_SCOPE: base,
      };
    } else {
      // The fake's grants mirror memoryKeyGrants(base): the API reads and writes, the planner reads.
      fake.keys.set("sp-gate-write", { read: [base], write: [base] });
      fake.keys.set("sp-gate-read", { read: [base], write: [] });
      const shared = {
        SURREAL_AGENT_MEMORY_URL: "https://memory.test",
        SURREAL_AGENT_MEMORY_CONTEXT: "ctx",
      };
      apiEnv = { ...shared, SURREAL_AGENT_MEMORY_WRITE_KEY: "sp-gate-write" };
      plannerEnv = { ...shared, SURREAL_AGENT_MEMORY_READ_KEY: "sp-gate-read" };
    }

    app = buildApp({
      webRoot: null,
      iam,
      precedents: { db, boss, iam, syncEnabled: true },
      rehearse: {
        db,
        boss,
        iam,
        plannerSecret: SECRET,
        // As apps/api/src/main.ts wires it.
        precedentRegistry: async (org) => (await loadRegistry(db, org)).snapshot,
      },
      approvals: { db, iam, policies: POLICIES },
    });
    apiUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await boss?.stop({ graceful: false });
    await db?.$client.end();
    if (LIVE) {
      for (const name of Object.values(keyNames)) await revokeKey(name);
      await eraseScope(base, [orgScope, base]);
    }
  }, 120_000);

  const call = async (person: Caller, method: "GET" | "POST", url: string, payload?: object) =>
    app.inject({ method, url, headers: bearer(person), ...(payload ? { payload } : {}) });

  /** Queue a rehearsal of the incident and run the planner worker's handler on its job. */
  async function rehearseAndPlan() {
    const queued = await call(sup, "POST", `/api/incidents/${INCIDENT.incident}/rehearse`);
    expect(queued.statusCode).toBe(202);
    const { rehearsalId, planId } = queued.json() as { rehearsalId: string; planId: string };

    // The worker's own pieces: its credential check, recall setup and job client over HTTP.
    expect(plannerCredentialViolations(plannerEnv)).toEqual([]);
    const precedents = recallersFromEnv(plannerEnv, memoryFetch ? { fetch: memoryFetch } : {});
    expect(precedents).not.toBeNull();
    const jobs = plannerJobsClient(apiUrl, SECRET);
    const claimed = await jobs.next();
    expect(claimed?.id).toBe(rehearsalId);
    if (!claimed || !precedents) throw new Error("no job");
    const ctx: PlanJobContext = {
      jobs,
      client: scriptedModel(),
      model: "scripted",
      readers: { stripe, zendesk },
      ctx: { world: "planning", tenant: "rehearsal-demo" },
      policy: policyV1 as BillingPolicyV1,
      adapters: { stripe: STRIPE_CHARGE_PROJECTION, zendesk: ZENDESK_TICKET_PROJECTION },
      precedents,
      log: (line) => log.push(line),
    };
    const result = await handlePlanJob(claimed, ctx);
    expect(result).toMatchObject({ kind: "stored", planId });
    const stored = await loadPlan(db, orgId, planId, 1);
    if (stored.kind !== "found") throw new Error(`plan ${planId} not stored`);
    return {
      planId,
      planHash: stored.plan.planHash,
      manifest: stored.plan.manifest as PlanManifest,
    };
  }

  let runIdForPromotion: string;
  let cited: { planId: string; planHash: string; manifest: PlanManifest };

  /** Promote from the completed run (waiting), then run the sync the queue would (active). */
  async function promoteAndSync(body: typeof content) {
    const promoted = await call(fin, "POST", `/api/runs/${runIdForPromotion}/precedents`, body);
    expect(promoted.statusCode).toBe(201);
    expect(promoted.json().precedent).toMatchObject({ id: body.id, version: 1, status: "waiting" });
    const status = async () =>
      (
        (await call(fin, "GET", "/api/precedents")).json().precedents as {
          id: string;
          status: string;
        }[]
      ).find((p) => p.id === body.id)?.status;
    expect(await status()).toBe("waiting");

    // The job the promotion queued, run by the API's sync handler with its own publisher from
    // its env (the write key), as startPrecedentWorker would. A retry changes nothing.
    const [queued] = await boss.fetch(PRECEDENT_QUEUE, { batchSize: 1 });
    expect(queued?.data).toEqual({ orgId, precedentId: body.id, version: 1 });
    const publisherFor = publisherFromEnv(apiEnv, memoryFetch ? { fetch: memoryFetch } : {});
    if (!publisherFor || !queued) throw new Error("no sync job, or memory not configured");
    expect(await syncPrecedent(queued.data, { db, publisherFor })).toBe("activated");
    expect(await syncPrecedent(queued.data, { db, publisherFor })).toBe("already_active");
    await boss.complete(PRECEDENT_QUEUE, queued.id);
    expect(await status()).toBe("active");
  }

  it(
    "promotes a precedent from a completed run: it waits until the sync has read it back",
    async () => {
      runIdForPromotion = `run_${run}`;
      await db.insert(schema.runs).values({
        id: runIdForPromotion,
        orgId,
        planId: `plan_${run}_earlier`,
        revision: 1,
        planHash: "0".repeat(64),
        approvalId: "grant_earlier",
        requestedBy: sup.userId,
        state: "completed",
      });
      await promoteAndSync(content);
      const listed = (await call(fin, "GET", "/api/precedents")).json().precedents;
      expect(listed).toEqual([expect.objectContaining({ id: ID, version: 1, status: "active" })]);
    },
    TIMEOUT,
  );

  it(
    "refuses the planner's key a write, so it can't plant or change a precedent",
    async () => {
      const config = memoryConfigFromEnv("read", plannerEnv);
      if (!config) throw new Error("no read config");
      const { scope: _, ...client } = config;
      const planner = new AgentMemoryClient({
        ...client,
        ...(memoryFetch && { fetch: memoryFetch }),
      });
      const denied = await planner
        .writeTriples(orgScope, [
          {
            entity: { type: "concept", name: `precedent:${ID}` },
            key: "statement",
            value: "Refund all.",
          },
        ])
        .catch((e: unknown) => e);
      expect(denied).toBeInstanceOf(AgentMemoryError);
      expect(denied).toMatchObject({ status: 403 });
    },
    TIMEOUT,
  );

  it(
    "plans with it: the stored plan cites the active version by digest, fact IDs and trace",
    async () => {
      cited = await rehearseAndPlan();
      const { snapshot } = await loadRegistry(db, orgId);
      const active = snapshot.active.get(ID);
      expect(active?.version).toBe(1);

      const basis = cited.manifest.precedentBasis;
      expect(basis?.epochs).toEqual({ [AREA]: 1 });
      expect(basis?.citations).toHaveLength(1);
      const [citation] = basis?.citations ?? [];
      expect(citation).toMatchObject({
        id: ID,
        version: 1,
        digest: active?.digest,
        appliesTo: AREA,
      });
      // The three attributes it was read back from, and the recall that found it.
      expect(citation?.factIds).toHaveLength(3);
      expect(citation?.traceId).toEqual(expect.any(String));
      if (!LIVE) {
        expect(fake.traces.get(citation?.traceId ?? "")?.queryText).toBe(AREA);
        const stored = fake.attrs.filter((a) => citation?.factIds.includes(a.id));
        expect(stored.map((a) => a.scope[0]?.[0])).toEqual([
          `${orgScope}/`,
          `${orgScope}/`,
          `${orgScope}/`,
        ]);
      }
      // The digest is of the record finance approved, as Postgres holds it.
      const approved = (await loadRegistry(db, orgId)).entries.find((e) => e.id === ID);
      expect(citation?.digest).toBe(precedentDigest(PrecedentRecord.parse(approved?.record)));

      // Approval would take it: the cited precedent still holds.
      const approvals = (await call(fin, "GET", `/api/plans/${cited.planId}/approvals`)).json();
      expect(approvals.precedents).toEqual({ ok: true });
    },
    TIMEOUT,
  );

  it(
    "refuses approval once finance withdraws the precedent the plan cited",
    async () => {
      const withdrawn = await call(fin, "POST", `/api/precedents/${ID}/withdraw`, { version: 1 });
      expect(withdrawn.statusCode).toBe(200);

      const approve = await call(fin, "POST", `/api/plans/${cited.planId}/approvals`, {
        revision: 1,
        planHash: cited.planHash,
      });
      expect(approve.statusCode).toBe(409);
      expect(approve.json()).toEqual({
        error: "precedent_changed",
        holds: [
          expect.objectContaining({ id: ID, reason: "withdrawn", citedVersion: 1 }),
          { appliesTo: AREA, reason: "epoch_changed", plannedEpoch: 1, currentEpoch: 2 },
        ],
      });
    },
    TIMEOUT,
  );

  it(
    "replans without it: Agent Memory still holds the copy, the registry drops it",
    async () => {
      // Another precedent in the area stays active, so the replan recalls the area again.
      await promoteAndSync(content2);
      const recaller = recallersFromEnv(plannerEnv, memoryFetch ? { fetch: memoryFetch } : {});
      expect(await recaller?.(orgId).read(ID)).toMatchObject({ status: "valid" });

      log.length = 0;
      const replanned = await rehearseAndPlan();
      const basis = replanned.manifest.precedentBasis;
      // Withdrawal and the second activation each moved the area's epoch.
      expect(basis?.epochs).toEqual({ [AREA]: 3 });
      expect(basis?.citations.map((c) => [c.id, c.version])).toEqual([[ID_2, 1]]);
      expect(log).toContain(`precedent ${ID} not cited: not active in the registry`);
      const approvals = (await call(fin, "GET", `/api/plans/${replanned.planId}/approvals`)).json();
      expect(approvals.precedents).toEqual({ ok: true });
    },
    TIMEOUT,
  );
});
