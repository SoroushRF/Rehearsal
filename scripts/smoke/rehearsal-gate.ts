import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { isDeepStrictEqual, parseEnv } from "node:util";
import type {
  ExecutionRehearsalReport,
  Observation,
  PlanManifest,
  QueryObservation,
  Receipt,
} from "@rehearsal/contracts";
import { fingerprint } from "@rehearsal/core";
import { createDb, IN_FLIGHT_KEPT, loadRegistry, migrateDb, schema } from "@rehearsal/db";
import {
  eraAdmin,
  eraFetch,
  mintTenantToken,
  REHEARSAL_TENANT_TOKEN_ROUTE,
  resolveWorld,
  STRIPE_CHARGE_PROJECTION,
  stripeChargeProjection,
  type WorldConfig,
  ZENDESK_TICKET_PROJECTION,
  zendeskTicketProjection,
} from "@rehearsal/providers";
import { billingManifest, INCIDENT, incidentRecords } from "@rehearsal/testkit";
import { storePlan } from "../../apps/api/src/plans";
import { adminOrThrow, type EraVendor, getJson } from "../inject/session";
import { incidentSnapshot, seedIncident } from "../seed/incident";
import { rehearsalAdminToken, rehearsalWorldConfig } from "../seed/snapshot";
import { type GateSession, openSession } from "./gate-clerk";

/**
 * T4.13: the isolation and recovery gate (docs/acceptance/T4.13-isolation-recovery-gate.md) on the
 * real local stack. IAM, the API and the executor worker run as their own processes with their own
 * env files; this script owns the rehearsal worker process so it can kill and restart it. Every
 * check goes through the API as a real Clerk session, the way a reviewer would. Setup (the stored
 * plans and the precedent the planner would have cited) and the read-only checks of what was
 * written use Postgres directly. Era admin is used only to seed, to read rh- tenants, to put a
 * phantom in the operational world, and for the latency the kill and cancel drills need.
 *
 *   pnpm smoke:rehearsal-gate prepare   migrate the gate database, reset and seed the gate tenant
 *   pnpm smoke:rehearsal-gate run       G1, G2 and G3; one PASS/FAIL line per check
 *
 * Refuses to run unless ERA_REHEARSAL=1 and DB_TESTS are set, the Era tenant is a gate tenant
 * (`t413-…`) and the database is a gate database (its name contains `gate`).
 */

const ROOT = resolve(import.meta.dirname, "../..");
const env = process.env;
const mode = process.argv[2] ?? "run";

function need(key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is not set`);
  return value;
}

if (env.ERA_REHEARSAL !== "1" || !env.DB_TESTS) {
  console.error("refusing: the gate needs ERA_REHEARSAL=1 and DB_TESTS set");
  process.exit(1);
}
const TENANT = need("ERA_TENANT");
if (!/^t413-[a-z0-9-]+$/.test(TENANT)) {
  console.error(
    `refusing: ERA_TENANT ${TENANT} is not a gate tenant (t413-…); shared tenants stay untouched`,
  );
  process.exit(1);
}
const DATABASE_URL = need("DATABASE_URL");
if (!new URL(DATABASE_URL).pathname.includes("gate")) {
  console.error("refusing: DATABASE_URL is not a gate database (its name must contain `gate`)");
  process.exit(1);
}
// Throws when a rehearsal URL is a planning or operational world's.
rehearsalWorldConfig("stripe", "t413check", env);
rehearsalWorldConfig("zendesk", "t413check", env);

const db = createDb(DATABASE_URL);
const sql = async <T = Record<string, unknown>>(text: string, values: unknown[] = []) =>
  (await db.$client.query(text, values)).rows as T[];

async function gateWorld(vendor: EraVendor, world: "planning" | "operational") {
  const config: WorldConfig = { ...resolveWorld(vendor, world), tenant: TENANT };
  const { token } = await mintTenantToken(config, need("ERA_ADMIN_TOKEN"));
  return { ...config, tenantToken: token };
}
const WORLDS = [
  ["stripe", "planning"],
  ["stripe", "operational"],
  ["zendesk", "planning"],
  ["zendesk", "operational"],
] as const;

if (mode === "prepare") {
  await migrateDb(db);
  for (const [vendor, world] of WORLDS) {
    const bound = await gateWorld(vendor, world);
    const res = await eraAdmin(bound, need("ERA_ADMIN_TOKEN"), "/reset");
    if (!res.ok) throw new Error(`reset ${vendor}/${world} → ${res.status}`);
    await seedIncident(vendor, bound);
    console.log(`seeded ${vendor}/${world} tenant ${TENANT}`);
  }
  console.log(`migrated ${new URL(DATABASE_URL).pathname.slice(1)}`);
  await db.$client.end();
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// Results

type Result = { id: string; ok: boolean; line: string };
const results: Result[] = [];
function check(id: string, ok: boolean, line: string) {
  results.push({ id, ok, line });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${line}`);
}
const note = (line: string) => console.log(`     ${line}`);

// ---------------------------------------------------------------------------------------------
// The plans: the fixture plan's case_001 and case_002 on the seeded cohort's c01 and c02, with
// stripe.charge.v2 / zendesk.ticket.v2 planning evidence the seeder can rebuild.

const records = incidentRecords();
const CASES = [
  { key: "c01", caseId: "case_001", n: "001" },
  { key: "c02", caseId: "case_002", n: "002" },
] as const;

function gatePlan(orgId: string, planId: string, opts: { refused?: boolean } = {}): PlanManifest {
  const base = billingManifest(planId);
  const observations: Observation[] = [];
  const queries: QueryObservation[] = [];
  const actions: PlanManifest["actions"] = [];
  for (const { key, caseId, n } of CASES) {
    const c = records.cases.find((x) => x.key === key);
    if (!c) throw new Error(`cohort has no ${key}`);
    const charges = records.stripe.charges.filter((x) => x.customer === c.customerId);
    const ticket = records.zendesk.tickets.find((t) => t.id === c.ticketId) ?? {};
    const obs = (id: string, kind: "charge" | "ticket", projection: Record<string, unknown>) =>
      ({
        id,
        world: "planning",
        entity: {
          vendor: kind === "charge" ? "stripe" : "zendesk",
          kind,
          id: String(projection.id),
        },
        projectionVersion: kind === "charge" ? STRIPE_CHARGE_PROJECTION : ZENDESK_TICKET_PROJECTION,
        projection,
        fingerprint: fingerprint(projection),
        capturedAt: "2026-10-24T00:00:00.000Z",
      }) as Observation;
    const charge = obs(`obs_charge_${n}`, "charge", stripeChargeProjection(charges[1] ?? {}));
    const tick = obs(`obs_ticket_${n}`, "ticket", zendeskTicketProjection(ticket));
    // `refused`: case_001's query leaves out the charge it cites, so the seeded tenant reads back
    // a member the evidence says isn't there and the snapshot is refused before anything runs.
    const listed =
      opts.refused && n === "001" ? charges.filter((x) => x.id !== charge.entity.id) : charges;
    const projections = Object.fromEntries(
      listed.map((x) => [String(x.id), stripeChargeProjection(x)]),
    );
    const matchingIds = Object.keys(projections).sort();
    const query: QueryObservation = {
      id: `q_charges_${n}`,
      world: "planning",
      vendor: "stripe",
      predicate: {
        kind: "stripe.charges.byCustomerInWindow",
        customerId: c.customerId,
        ...INCIDENT.window,
      },
      cutoff: "2026-10-24T00:00:00.000Z",
      complete: true,
      matchingIds,
      projectionVersion: STRIPE_CHARGE_PROJECTION,
      projections,
      fingerprint: fingerprint({ matchingIds, projections }),
      capturedAt: "2026-10-24T00:00:00.000Z",
    };
    observations.push(charge, tick);
    queries.push(query);
    for (const a of base.actions.filter((x) => x.caseId === caseId)) {
      const copy = structuredClone(a);
      if (copy.kind === "stripe.refund.create") {
        copy.args.chargeId = charge.entity.id;
        copy.args.amount.amountMinor = Number(charge.projection.amount);
        copy.evidence = [charge.id];
        copy.queryEvidence = [query.id];
      } else if (
        copy.kind === "zendesk.ticket.patchFields" ||
        copy.kind === "zendesk.ticket.appendPrivateNote"
      ) {
        copy.args.ticketId = tick.entity.id;
        copy.evidence = [tick.id];
        copy.queryEvidence = [];
        if (copy.kind === "zendesk.ticket.appendPrivateNote") {
          copy.args.bindings = {
            ...copy.args.bindings,
            amountMinor: Number(charge.projection.amount),
          };
        }
      }
      actions.push(copy);
    }
  }
  return { ...base, orgId, observations, queryObservations: queries, actions } as PlanManifest;
}

const chargeOf = (m: PlanManifest, actionId: string) => {
  const a = m.actions.find((x) => x.id === actionId);
  return a?.kind === "stripe.refund.create" ? a.args.chargeId : "";
};

// ---------------------------------------------------------------------------------------------
// The API, as people

const API = need("GATE_API_URL").replace(/\/$/, "");
type Reply = { status: number; body: Record<string, unknown> };

async function call(
  who: GateSession | null,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(who ? { authorization: `Bearer ${await who.token()}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

const until = async <T>(
  what: string,
  fn: () => Promise<T | null | undefined>,
  ms = 120_000,
  every = 250,
) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline; ) {
    const v = await fn();
    if (v !== null && v !== undefined) return v;
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error(`timed out waiting for ${what}`);
};

type Summary = {
  rehearsalId: string;
  plan: { orgId: string; planId: string; revision: number; planHash: string };
  scenario: { id: string; version: number };
  state: string;
  detail: string | null;
};
const TERMINAL = ["completed", "failed", "cancelled"];
const SETTLED_ATTEMPTS = ["confirmed", "rejected", "reconciled"];
/** Per vendor request on the rehearsal containers while a run is cancelled or killed mid-send. */
const STEP_LATENCY_MS = 400;

async function summaries(who: GateSession, planId: string): Promise<Summary[]> {
  const r = await call(who, "GET", `/api/plans/${planId}/execution-rehearsals`);
  if (r.status !== 200) throw new Error(`list ${planId} → ${r.status}`);
  return r.body.rehearsals as Summary[];
}

async function rehearse(who: GateSession, planId: string, scenario: string, key: string) {
  const plan = await call(who, "GET", `/api/plans/${planId}`);
  const res = await call(
    who,
    "POST",
    `/api/plans/${planId}/execution-rehearsals`,
    {
      planId,
      revision: plan.body.revision,
      planHash: plan.body.planHash,
      scenario: { id: scenario, version: 1 },
    },
    { "idempotency-key": key },
  );
  if (res.status !== 201) throw new Error(`rehearse ${planId} ${scenario} → ${res.status}`);
  return (res.body.rehearsal as Summary).rehearsalId;
}

async function settled(who: GateSession, planId: string, id: string, ms = 180_000) {
  const done = await until(
    `rehearsal ${id}`,
    async () => {
      const s = (await summaries(who, planId)).find((x) => x.rehearsalId === id);
      return s && TERMINAL.includes(s.state) ? s : null;
    },
    ms,
  );
  // Teardown is the last event; wait for it (or give up, and say so in the check).
  await until(`teardown of ${id}`, () => tornDown(id).then((t) => t || null), 60_000).catch(
    () => null,
  );
  return done;
}

async function report(who: GateSession, id: string) {
  const r = await call(who, "GET", `/api/execution-rehearsals/${id}/report`);
  return r.status === 200 ? (r.body.report as ExecutionRehearsalReport) : null;
}

const tornDown = async (id: string) =>
  (
    await sql(
      "select 1 from rehearsal_events where rehearsal_id = $1 and torn_down_at is not null",
      [id],
    )
  ).length > 0;
const attemptsOf = (id: string) =>
  sql<{ action_id: string; state: string; attempt_no: number; prepared_at: Date }>(
    "select action_id, state, attempt_no, prepared_at from rehearsal_attempts where rehearsal_id = $1 order by prepared_at",
    [id],
  );
/** Attempts journaled since `before` was read: any row it didn't have is a fresh send. */
const newAttempts = (
  before: { action_id: string; attempt_no: number }[],
  after: { action_id: string; attempt_no: number }[],
) => {
  const seen = new Set(before.map((a) => `${a.action_id}#${a.attempt_no}`));
  return after.filter((a) => !seen.has(`${a.action_id}#${a.attempt_no}`));
};
const eventsOf = (id: string) =>
  sql<{ state: string; detail: string | null; at: Date }>(
    "select state, detail, at from rehearsal_events where rehearsal_id = $1 order by seq",
    [id],
  );

const steps = (r: ExecutionRehearsalReport | null) =>
  Object.fromEntries((r?.steps ?? []).map((s) => [s.actionId, s]));
const outcomes = (r: ExecutionRehearsalReport | null) =>
  (r?.steps ?? [])
    .map((s) => `${s.actionId}=${s.result?.outcome ?? "never ran"}/${s.verification.status}`)
    .join(" ");

// ---------------------------------------------------------------------------------------------
// Operator reads of a rehearsal's own tenant and the rehearsal container's faults

async function rehearsalTenant(vendor: EraVendor, id: string): Promise<WorldConfig> {
  const config = rehearsalWorldConfig(vendor, id, env);
  const { token } = await mintTenantToken(config, rehearsalAdminToken(env));
  return { ...config, tenantToken: token };
}
async function tenantStatus(vendor: EraVendor, id: string, path: string) {
  const world = await rehearsalTenant(vendor, id);
  const auth = vendor === "stripe" ? "Bearer sk_test_t413_gate" : "Bearer t413-gate";
  const res = await eraFetch(world, path, { headers: { authorization: auth } });
  return {
    status: res.status,
    body: res.ok ? ((await res.json()) as Record<string, unknown>) : null,
  };
}
async function refundsIn(id: string, chargeId: string) {
  const r = await tenantStatus("stripe", id, `/v1/refunds?charge=${chargeId}&limit=100`);
  return r.body ? (r.body.data as unknown[]).length : null;
}

async function rehearsalFaults(config: Record<string, unknown> | null) {
  for (const key of ["ERA_STRIPE_REHEARSAL_URL", "ERA_ZENDESK_REHEARSAL_URL"]) {
    const base = need(key).replace(/\/$/, "");
    const path = config === null ? "/_admin/faults/reset" : "/_admin/faults";
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${rehearsalAdminToken(env)}`,
        "content-type": "application/json",
      },
      ...(config === null ? {} : { body: JSON.stringify(config) }),
    });
    if (!res.ok) throw new Error(`${key}${path} → ${res.status}`);
  }
}
async function faultsCleared() {
  for (const key of ["ERA_STRIPE_REHEARSAL_URL", "ERA_ZENDESK_REHEARSAL_URL"]) {
    const res = await fetch(`${need(key).replace(/\/$/, "")}/_admin/faults`, {
      headers: { authorization: `Bearer ${rehearsalAdminToken(env)}` },
    });
    const f = (await res.json()) as Record<string, unknown>;
    if (f.latency_ms !== 0 || f.error_rate !== 0 || f.fail_next !== 0 || f.throttle) return false;
  }
  return true;
}

// The worker's mint route, as the worker would call it (its secret only).
const mint = (body: unknown, secret = need("REHEARSAL_WORKER_SECRET")) =>
  fetch(`${API}${REHEARSAL_TENANT_TOKEN_ROUTE}`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.status);

// ---------------------------------------------------------------------------------------------
// The rehearsal worker process: only its own env file plus its secret, as `pnpm rehearsal start`.

const OS_KEYS = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "ComSpec",
];
function workerEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of OS_KEYS) if (env[k] !== undefined) out[k] = env[k];
  const file = parseEnv(readFileSync(need("GATE_REHEARSAL_ENV_FILE"), "utf8"));
  return { ...out, ...file, REHEARSAL_WORKER_SECRET: need("REHEARSAL_WORKER_SECRET"), ...over };
}
const TSX = createRequire(import.meta.url).resolve("tsx/cli");
let worker: ChildProcess | undefined;
let workerLog = "";

function spawnWorker(over: Record<string, string> = {}) {
  const child = spawn(process.execPath, [TSX, "apps/rehearsal-worker/src/main.ts"], {
    cwd: ROOT,
    env: workerEnv(over),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  const add = (d: Buffer) => {
    log += d.toString();
    workerLog += d.toString();
  };
  child.stdout?.on("data", add);
  child.stderr?.on("data", add);
  return { child, log: () => log };
}

async function startWorker() {
  const w = spawnWorker();
  worker = w.child;
  await until("the rehearsal worker", async () =>
    w.log().includes("rehearsal-worker consuming")
      ? true
      : w.child.exitCode !== null
        ? false
        : null,
  ).then((ok) => {
    if (!ok) throw new Error(`the rehearsal worker didn't start:\n${w.log()}`);
  });
  note(`rehearsal worker started (pid ${w.child.pid})`);
}
function killWorker() {
  if (!worker?.pid || worker.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(worker.pid), "/T", "/F"]);
  } else worker.kill("SIGKILL");
}

// ---------------------------------------------------------------------------------------------
// World snapshots (as snapshot-seed.test.ts reads them, plus the cohort's charges and tickets)

async function worldsSnapshot() {
  const out: Record<string, unknown> = {};
  for (const [vendor, world] of WORLDS) {
    const bound = await gateWorld(vendor, world);
    out[`${vendor}/${world}`] = {
      contents:
        vendor === "stripe"
          ? await getJson(vendor, bound, "/v1/charges?limit=100")
          : await getJson(vendor, bound, "/api/v2/tickets.json?per_page=100"),
      cohort: await incidentSnapshot(vendor, bound),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Setup

const STAMP = randomBytes(3).toString("hex");
const clerkKeys = {
  secretKey: need("CLERK_SECRET_KEY"),
  publishableKey: need("CLERK_PUBLISHABLE_KEY"),
  origin:
    env.GATE_ORIGIN ??
    env.CLERK_AUTHORIZED_PARTIES?.split(",").at(-1)?.trim() ??
    "http://localhost:5173",
};
const support = await openSession(clerkKeys, env.GATE_SUPPORT_USER ?? "rehearsal-support");
const finance = await openSession(clerkKeys, env.GATE_FINANCE_USER ?? "rehearsal-finance");
const other = await openSession(clerkKeys, env.GATE_OTHER_ORG_USER ?? "rehearsal-member");
const ORG = support.orgId ?? "";
for (const s of [support, finance, other]) {
  note(
    `signed in ${s.username} (${s.userId}) in ${s.orgId} as ${s.orgRole}, session ${s.sessionId}`,
  );
}
if (!ORG || finance.orgId !== ORG || other.orgId === ORG) {
  throw new Error("support and finance must share an org, and the other-org user must not");
}

const plans = {
  main: gatePlan(ORG, `plan_t413_main_${STAMP}`),
  apply: gatePlan(ORG, `plan_t413_apply_${STAMP}`),
  prec: gatePlan(ORG, `plan_t413_prec_${STAMP}`),
  refused: gatePlan(ORG, `plan_t413_baseline_${STAMP}`, { refused: true }),
  corrupt: gatePlan(ORG, `plan_t413_corrupt_${STAMP}`),
  route: gatePlan(ORG, `plan_t413_route_${STAMP}`),
};
const PRECEDENT = `t413-dup-refund-${STAMP}`;
const AREA = "billing.duplicate_charge";
const precedentRecord = {
  id: PRECEDENT,
  version: 1,
  appliesTo: AREA,
  statement: "A duplicate charge in the incident window is refunded once, in full.",
  conditions: ["two charges of the same amount within the incident window"],
  exceptions: [],
  effectiveFrom: "2026-09-01",
  effectiveUntil: null,
  author: { userId: finance.userId, role: "finance_lead" },
  approvedAt: new Date().toISOString(),
};
const precedentDigest = fingerprint(precedentRecord);
// The precedent as planning saw it: approved and active (promotion and the Agent Memory sync are
// T2.17's path; the gate seeds the registry they would leave).
await db.insert(schema.precedentEvents).values([
  {
    orgId: ORG,
    precedentId: PRECEDENT,
    version: 1,
    appliesTo: AREA,
    kind: "approved",
    digest: precedentDigest,
    record: precedentRecord,
    actorUserId: finance.userId,
    sourceRunId: "run_t413_seed",
  },
  {
    orgId: ORG,
    precedentId: PRECEDENT,
    version: 1,
    appliesTo: AREA,
    kind: "activated",
    digest: precedentDigest,
  },
]);
// The basis records the area's epoch as planning would read it, with this precedent in force.
const areaEpoch = (await loadRegistry(db, ORG)).snapshot.epochs.get(AREA) ?? 0;
plans.prec.precedentBasis = {
  citations: [
    {
      id: PRECEDENT,
      version: 1,
      digest: precedentDigest,
      appliesTo: AREA,
      factIds: ["fact_t413"],
      traceId: "trace_t413",
    },
  ],
  epochs: { [AREA]: areaEpoch },
};
for (const p of Object.values(plans)) {
  if (!(await storePlan(db, p))) throw new Error(`plan ${p.planId} not stored`);
}
// The stored hash no longer matches the stored content.
await sql(
  `update plan_versions set manifest = jsonb_set(manifest, '{actions,0,args,amount,amountMinor}', '1') where plan_id = $1`,
  [plans.corrupt.planId],
);
note(
  `stored ${Object.values(plans)
    .map((p) => p.planId)
    .join(", ")}; precedent ${PRECEDENT} v1 active (${AREA} epoch ${areaEpoch})`,
);

await rehearsalFaults(null);
await startWorker();
const before = await worldsSnapshot();
const state: Record<string, unknown> = {
  api: API,
  orgId: ORG,
  plans: Object.fromEntries(Object.entries(plans).map(([k, p]) => [k, p.planId])),
  precedent: PRECEDENT,
  rehearsals: {} as Record<string, string>,
};
const ids = state.rehearsals as Record<string, string>;

try {
  // -------------------------------------------------------------------------------------------
  // G1. The happy path keeps the plan and the shared worlds intact

  const main = plans.main.planId;
  const stored = await call(support, "GET", `/api/plans/${main}`);
  const hash = stored.body.planHash as string;
  const missingHash = await call(support, "POST", `/api/plans/${main}/execution-rehearsals`, {
    planId: main,
    revision: 1,
    planHash: "0".repeat(64),
    scenario: { id: "clean", version: 1 },
  });
  check(
    "G1.unstored-hash",
    missingHash.status === 409 &&
      missingHash.body.error === "hash_mismatch" &&
      (await summaries(support, main)).length === 0,
    `a hash that isn't stored → ${missingHash.status} ${missingHash.body.error}; no rehearsal row`,
  );

  ids.clean = await rehearse(support, main, "clean", `t413-clean-${STAMP}`);
  const clean = await settled(support, main, ids.clean);
  const cleanReport = await report(support, ids.clean);
  const after = await call(support, "GET", `/api/plans/${main}`);
  check(
    "G1.binding",
    clean.plan.planId === main &&
      clean.plan.revision === 1 &&
      clean.plan.planHash === hash &&
      cleanReport?.plan.planHash === hash &&
      cleanReport.plan.revision === 1 &&
      after.body.planHash === hash &&
      after.body.revision === 1,
    `rehearsal ${ids.clean} names ${main} r1 ${hash.slice(0, 12)}…; plan unchanged after (r${after.body.revision} ${String(after.body.planHash).slice(0, 12)}…)`,
  );
  check(
    "G1.verifier-report",
    clean.state === "completed" &&
      cleanReport?.verdict === "passed" &&
      cleanReport.versions.verifier === "verifier@1" &&
      cleanReport.evidence === "era_integration" &&
      cleanReport.steps.length === 6 &&
      cleanReport.steps.every(
        (s) => s.verification.status === "matched" && s.verification.detail.length > 0,
      ),
    `report ${ids.clean}: ${cleanReport?.state}/${cleanReport?.verdict}, ${cleanReport?.versions.verifier}, evidence ${cleanReport?.evidence}, commit ${cleanReport?.versions.commit}; ${outcomes(cleanReport)}`,
  );
  if (cleanReport)
    note(`verifier on refund_001: ${steps(cleanReport).refund_001?.verification.detail}`);

  // -------------------------------------------------------------------------------------------
  // G3. Recovery and honest reports (the challenges first, the drills after)

  ids.phantom = await rehearse(support, main, "phantom_membership", `t413-phantom-${STAMP}`);
  await settled(support, main, ids.phantom);
  const phantom = await report(support, ids.phantom);
  const ph = steps(phantom);
  check(
    "G3.phantom",
    phantom?.state === "completed" &&
      ph.refund_001?.result?.outcome === "held" &&
      ["query_membership_changed", "row_changed"].includes(
        ph.refund_001.result.holdReason?.kind ?? "",
      ) &&
      ph.note_001?.result?.outcome === "skipped_dependency" &&
      ph.patch_001?.result?.outcome === "confirmed" &&
      ["refund_002", "patch_002", "note_002"].every(
        (a) => ph[a]?.result?.outcome === "confirmed",
      ) &&
      phantom.verdict === "passed",
    `report ${ids.phantom}: refund_001 ${ph.refund_001?.result?.outcome} (${ph.refund_001?.result?.holdReason?.kind}), dependents skipped, c02 proceeds; ${outcomes(phantom)}; verdict ${phantom?.verdict}`,
  );

  ids.teammate = await rehearse(support, main, "teammate_field_edit", `t413-teammate-${STAMP}`);
  await settled(support, main, ids.teammate);
  const teammate = await report(support, ids.teammate);
  const tm = steps(teammate);
  const patchLimits = tm.patch_001?.result?.limitations.join("; ") ?? "";
  check(
    "G3.teammate",
    teammate?.state === "completed" &&
      tm.note_001?.result?.outcome === "rejected" &&
      tm.patch_001?.verification.status === "matched" &&
      /conflict|teammate|kept/i.test(`${patchLimits} ${tm.patch_001?.verification.detail}`) &&
      teammate.verdict === "passed",
    `report ${ids.teammate}: note_001 ${tm.note_001?.result?.outcome}; patch_001 ${tm.patch_001?.result?.outcome}/${tm.patch_001?.verification.status} — "${patchLimits}" / "${tm.patch_001?.verification.detail}"; verdict ${teammate?.verdict}`,
  );

  ids.benign = await rehearse(support, main, "benign_nonmatching_change", `t413-benign-${STAMP}`);
  await settled(support, main, ids.benign);
  const benign = await report(support, ids.benign);
  check(
    "G3.benign-control",
    benign?.state === "completed" &&
      benign.verdict === "passed" &&
      benign.steps.every(
        (s) => s.result?.outcome === "confirmed" && s.verification.status === "matched",
      ),
    `report ${ids.benign}: nothing held; ${outcomes(benign)}; verdict ${benign?.verdict}`,
  );

  ids.lost = await rehearse(support, main, "lost_response_restart", `t413-lost-${STAMP}`);
  await settled(support, main, ids.lost);
  const lost = await report(support, ids.lost);
  const lostAttempts = (await attemptsOf(ids.lost)).filter((a) => a.action_id === "refund_001");
  check(
    "G3.lost-response",
    lost?.state === "completed" &&
      steps(lost).refund_001?.result?.outcome === "confirmed" &&
      steps(lost).refund_001?.verification.status === "matched" &&
      lostAttempts.length === 1 &&
      lostAttempts[0]?.state === "reconciled" &&
      lost.verdict === "passed",
    `report ${ids.lost}: refund_001 attempts ${JSON.stringify(lostAttempts.map((a) => a.state))} (sent once, settled by a read); verifier "${steps(lost).refund_001?.verification.detail}"; verdict ${lost?.verdict}`,
  );

  // Cancel mid-run. A whole run takes a fraction of a second, so every vendor request on the
  // rehearsal containers is slowed first (provisioning's read-back too, well inside the lease),
  // and the cancel goes through the API the moment the first send is on the wire.
  await rehearsalFaults({ latency_ms: STEP_LATENCY_MS });
  const cancelId = await rehearse(support, main, "clean", `t413-cancel-${STAMP}`);
  ids.cancel = cancelId;
  const inFlight = await until(
    "a send in flight",
    async () => {
      const a = await attemptsOf(cancelId);
      return a.some((x) => x.state === "dispatched") ? a : null;
    },
    120_000,
    25,
  );
  const cancelled = await call(
    support,
    "POST",
    `/api/execution-rehearsals/${ids.cancel}/cancel`,
    {},
  );
  note(
    `cancel → ${cancelled.status} with ${JSON.stringify(inFlight.map((a) => [a.action_id, a.state]))} on the wire`,
  );
  await settled(support, main, ids.cancel);
  await rehearsalFaults(null);
  const cancelReport = await report(support, ids.cancel);
  const cancelAttempts = await attemptsOf(ids.cancel);
  const sentAfter = newAttempts(inFlight, cancelAttempts);
  const cs = cancelReport?.steps ?? [];
  const ran = cs.filter((s) => s.result);
  const neverRan = cs.filter((s) => !s.result).map((s) => s.actionId);
  const attempted = [...new Set(cancelAttempts.map((a) => a.action_id))].sort();
  const unresolved = cancelAttempts.filter((a) => !SETTLED_ATTEMPTS.includes(a.state));
  check(
    "G3.cancel",
    cancelled.status === 200 &&
      cancelReport?.state === "cancelled" &&
      cancelReport.verdict !== "passed" &&
      sentAfter.length === 0 &&
      neverRan.length > 0 &&
      // Every step that was sent says what happened; only the ones never tried say "never ran".
      isDeepStrictEqual(ran.map((s) => s.actionId).sort(), attempted) &&
      ran.every(
        (s) => s.result?.outcome !== "unknown_outcome" || s.verification.status !== "matched",
      ) &&
      (unresolved.length === 0 || cancelReport.limitations.includes(IN_FLIGHT_KEPT)),
    `report ${ids.cancel}: ${cancelReport?.state}/${cancelReport?.verdict}; ran ${ran.map((s) => `${s.actionId}=${s.result?.outcome}/${s.verification.status}`).join(",") || "none"}; never ran ${neverRan.join(",")}; sent ${attempted.join(",")}; unresolved ${unresolved.map((a) => a.action_id).join(",") || "none"}; attempts after cancel ${sentAfter.length}; attempts ${JSON.stringify(cancelAttempts.map((a) => [a.action_id, a.state]))}`,
  );
  if (cancelReport) note(`cancel limitations: ${cancelReport.limitations.join(" | ")}`);

  // Worker killed mid-run, then restarted. A rehearsal is never resumed: once its lease expires the
  // restarted worker's sweeper fails it, reads back what was sent and reports.
  await rehearsalFaults({ latency_ms: STEP_LATENCY_MS });
  const killId = await rehearse(support, main, "clean", `t413-kill-${STAMP}`);
  ids.kill = killId;
  const atKill = await until(
    "a send in flight",
    async () => {
      const a = await attemptsOf(killId);
      return a.some((x) => x.state === "dispatched") ? a : null;
    },
    120_000,
    25,
  );
  killWorker();
  note(`killed the worker with ${JSON.stringify(atKill.map((a) => [a.action_id, a.state]))}`);
  await rehearsalFaults(null);
  await new Promise((r) => setTimeout(r, 3000));
  const refundCharge = chargeOf(plans.main, "refund_001");
  const refundsAfterKill = await refundsIn(ids.kill, refundCharge);
  const stateAfterKill = (await summaries(support, main)).find(
    (s) => s.rehearsalId === ids.kill,
  )?.state;
  await startWorker();
  const killed = await settled(support, main, ids.kill, 240_000);
  const killReport = await report(support, ids.kill);
  const killAttempts = await attemptsOf(ids.kill);
  const perKey = new Map<string, number>();
  for (const a of killAttempts) perKey.set(a.action_id, (perKey.get(a.action_id) ?? 0) + 1);
  const newSends = newAttempts(atKill, killAttempts);
  const killEvents = await eventsOf(ids.kill);
  const sentAtKill = atKill.map((a) => a.action_id);
  const recovered = sentAtKill.every((a) => {
    const s = steps(killReport)[a];
    return s?.result !== null && s?.result !== undefined;
  });
  check(
    "G3.worker-kill",
    stateAfterKill !== undefined &&
      !TERMINAL.includes(stateAfterKill) &&
      killed.state === "failed" &&
      /lease expired/.test(String(killed.detail ?? "")) &&
      killReport !== null &&
      [...perKey.values()].every((n) => n === 1) &&
      newSends.length === 0 &&
      recovered &&
      (refundsAfterKill ?? 0) <= 1 &&
      killReport.verdict === "unknown",
    `rehearsal ${ids.kill}: ${stateAfterKill} at kill → ${killed.state} ("${killed.detail}"); report ${killReport?.state}/${killReport?.verdict}; ${outcomes(killReport)}; attempts ${JSON.stringify(killAttempts.map((a) => [a.action_id, a.state]))}; new sends after kill ${newSends.length}; refunds on ${refundCharge} after kill ${refundsAfterKill}`,
  );
  note(
    `kill events: ${killEvents.map((e) => `${e.state}${e.detail ? ` (${e.detail})` : ""}`).join(" → ")}`,
  );
  if (killReport) note(`kill limitations: ${killReport.limitations.join(" | ")}`);

  // A precedent withdrawn after planning: the control rehearses; after a finance lead withdraws the
  // precedent through the API, the same plan is refused before anything is sent, naming it.
  const prec = plans.prec.planId;
  ids.precedentControl = await rehearse(support, prec, "clean", `t413-prec-ok-${STAMP}`);
  const precOk = await settled(support, prec, ids.precedentControl);
  const withdrawn = await call(finance, "POST", `/api/precedents/${PRECEDENT}/withdraw`, {
    version: 1,
  });
  ids.precedentRefused = await rehearse(support, prec, "clean", `t413-prec-refused-${STAMP}`);
  const precRefused = await settled(support, prec, ids.precedentRefused);
  const precAttempts = await attemptsOf(ids.precedentRefused);
  check(
    "G3.precedent",
    precOk.state === "completed" &&
      withdrawn.status === 200 &&
      precRefused.state === "failed" &&
      (precRefused.detail ?? "").includes("precedent changed since planning") &&
      (precRefused.detail ?? "").includes(PRECEDENT) &&
      precAttempts.length === 0,
    `control ${ids.precedentControl} ${precOk.state}; withdraw → ${withdrawn.status}; ${ids.precedentRefused} ${precRefused.state}: "${precRefused.detail}"; attempts ${precAttempts.length}`,
  );

  // -------------------------------------------------------------------------------------------
  // G1 (continued): the shared worlds, the operational journal and teardown

  const afterWorlds = await worldsSnapshot();
  check(
    "G1.worlds-untouched",
    isDeepStrictEqual(before, afterWorlds),
    `planning and operational worlds of ${TENANT} read back identical after ${Object.keys(ids).length} rehearsals`,
  );
  const operational = await sql<{ t: string; n: string }>(
    `select 'step_attempts' t, count(*) n from step_attempts where org_id = $1 union all
     select 'step_receipts', count(*) from step_receipts where org_id = $1 union all
     select 'approval_grants', count(*) from approval_grants where org_id = $1 union all
     select 'runs', count(*) from runs where org_id = $1 union all
     select 'object_bindings', count(*) from object_bindings where org_id = $1`,
    [ORG],
  );
  const grants = await call(support, "GET", `/api/plans/${main}/approvals`);
  const runsList = await call(support, "GET", `/api/plans/${main}/runs`);
  check(
    "G1.no-operational-rows",
    operational.every((r) => Number(r.n) === 0) &&
      (grants.body.grants as unknown[]).length === 0 &&
      (runsList.body.runs as unknown[]).length === 0,
    `${operational.map((r) => `${r.t}=${r.n}`).join(" ")} for ${ORG}; API grants ${(grants.body.grants as unknown[]).length}, runs ${(runsList.body.runs as unknown[]).length}`,
  );
  const teardown: string[] = [];
  for (const [label, id] of Object.entries(ids)) {
    const down = await tornDown(id);
    const minted = await mint({ vendor: "stripe", rehearsalId: id });
    const read = await tenantStatus(
      "stripe",
      id,
      `/v1/charges/${chargeOf(plans.main, "refund_001")}`,
    );
    teardown.push(
      `${label} ${id}: torn down ${down}, mint ${minted}, rh-${id} charge ${read.status}`,
    );
    if (!(down && minted === 409 && read.status === 404)) teardown.push("  ^ not torn down");
  }
  check(
    "G1.teardown",
    !teardown.some((l) => l.includes("not torn down")),
    `every rh- tenant reset and refused to mint: ${teardown.length} rehearsals`,
  );
  for (const l of teardown) note(l);

  // -------------------------------------------------------------------------------------------
  // G2. Isolation refusals

  const countRehearsals = async () =>
    Number((await sql<{ n: string }>("select count(*) n from rehearsals"))[0]?.n);
  const rehearsalsBefore = await countRehearsals();
  const body = { planId: main, revision: 1, planHash: hash, scenario: { id: "clean", version: 1 } };
  const foreignStart = await call(other, "POST", `/api/plans/${main}/execution-rehearsals`, body);
  const missingStart = await call(
    other,
    "POST",
    "/api/plans/plan_t413_nowhere/execution-rehearsals",
    {
      ...body,
      planId: "plan_t413_nowhere",
    },
  );
  const foreignList = await call(other, "GET", `/api/plans/${main}/execution-rehearsals`);
  const foreignReport = await call(other, "GET", `/api/execution-rehearsals/${ids.clean}/report`);
  const missingReport = await call(other, "GET", "/api/execution-rehearsals/t413nowhere00/report");
  const foreignCancel = await call(
    other,
    "POST",
    `/api/execution-rehearsals/${ids.clean}/cancel`,
    {},
  );
  const missingCancel = await call(
    other,
    "POST",
    "/api/execution-rehearsals/t413nowhere00/cancel",
    {},
  );
  check(
    "G2.other-org",
    foreignStart.status === 404 &&
      isDeepStrictEqual(foreignStart, missingStart) &&
      foreignList.status === 404 &&
      foreignReport.status === 404 &&
      isDeepStrictEqual(foreignReport, missingReport) &&
      foreignCancel.status === 404 &&
      isDeepStrictEqual(foreignCancel, missingCancel) &&
      (await countRehearsals()) === rehearsalsBefore,
    `${other.username} (${other.orgRole} of ${other.orgId}): start ${foreignStart.status} ${foreignStart.body.error} = missing ${missingStart.status}; list ${foreignList.status}; report ${foreignReport.status} ${foreignReport.body.error} = missing ${missingReport.status}; cancel ${foreignCancel.status} = missing ${missingCancel.status}; nothing written`,
  );

  // Routing: the browser can't name a world or tenant; the mint route derives the tenant from a
  // live rehearsal; a worker given a planning or operational URL refuses to start.
  const routed = await call(support, "POST", `/api/plans/${main}/execution-rehearsals`, {
    ...body,
    worlds: { stripe: need("ERA_STRIPE_OPERATIONAL_URL") },
    tenant: TENANT,
  });
  const mintTenant = await mint({ vendor: "stripe", rehearsalId: ids.clean, tenant: TENANT });
  const mintEnded = await mint({ vendor: "stripe", rehearsalId: ids.clean });
  const mintShared = await mint({ vendor: "stripe", rehearsalId: "rehearsal-demo" });
  const mintWrongSecret = await mint(
    { vendor: "stripe", rehearsalId: ids.clean },
    "not-the-secret",
  );
  const apiRefusalsWroteNothing = (await countRehearsals()) === rehearsalsBefore;

  // A worker whose rehearsal URLs point at a shared world. It holds only rehearsal-tenant tokens,
  // which a shared world doesn't know: the run must fail with a recorded reason and write nothing.
  killWorker();
  const misrouted: { label: string; ok: boolean; say: string }[] = [];
  for (const label of ["operational", "planning"] as const) {
    const at = (vendor: "STRIPE" | "ZENDESK") => need(`ERA_${vendor}_${label.toUpperCase()}_URL`);
    const w = spawnWorker({
      ERA_STRIPE_REHEARSAL_URL: at("STRIPE"),
      ERA_ZENDESK_REHEARSAL_URL: at("ZENDESK"),
    });
    worker = w.child;
    const started = await until(
      `worker on ${label} URLs`,
      async () =>
        w.log().includes("rehearsal-worker consuming")
          ? "consuming"
          : w.child.exitCode !== null
            ? `exit ${w.child.exitCode}`
            : null,
      60_000,
    );
    if (started !== "consuming") {
      misrouted.push({ label, ok: true, say: `refused to start (${started}): ${w.log().trim()}` });
      continue;
    }
    const worldsBefore = await worldsSnapshot();
    const id = await rehearse(
      support,
      plans.route.planId,
      "clean",
      `t413-misrouted-${label}-${STAMP}`,
    );
    ids[`misrouted_${label}`] = id;
    const ended = await settled(support, plans.route.planId, id, 120_000);
    const sent = await attemptsOf(id);
    const landed = sent.filter((a) => a.state === "confirmed" || a.state === "reconciled");
    const untouched = isDeepStrictEqual(worldsBefore, await worldsSnapshot());
    const misreport = await report(support, id);
    killWorker();
    misrouted.push({
      label,
      ok: ended.state === "failed" && !!ended.detail && landed.length === 0 && untouched,
      say: `rehearsal ${id} ${ended.state} ("${ended.detail}"), verdict ${misreport?.verdict}: ${(misreport?.steps ?? []).map((s) => `${s.actionId}=${s.result?.outcome ?? "never ran"}${s.result?.holdReason ? `(${s.result.holdReason.kind})` : ""}`).join(" ")}; attempts ${sent.length}; ${label} world ${untouched ? "unchanged" : "CHANGED"}`,
    });
  }
  await startWorker();
  check(
    "G2.routing",
    routed.status === 400 &&
      mintTenant === 400 &&
      mintEnded === 409 &&
      mintShared === 400 &&
      mintWrongSecret === 401 &&
      apiRefusalsWroteNothing &&
      misrouted.length === 2 &&
      misrouted.every((m) => m.ok),
    `body naming a world/tenant → ${routed.status} ${routed.body.error}; mint naming a tenant → ${mintTenant}, an ended rehearsal → ${mintEnded}, "rehearsal-demo" → ${mintShared}, wrong secret → ${mintWrongSecret}; no rehearsal row from these; ${misrouted.map((m) => `worker on ${m.label} URLs: ${m.say}`).join("; ")}`,
  );

  // A stored hash that no longer matches its content; a baseline that doesn't match the evidence.
  const corrupt = plans.corrupt.planId;
  const rehearsalsBeforeCorrupt = await countRehearsals();
  const corruptStart = await call(support, "POST", `/api/plans/${corrupt}/execution-rehearsals`, {
    planId: corrupt,
    revision: 1,
    planHash: (
      await sql<{ plan_hash: string }>("select plan_hash from plan_versions where plan_id = $1", [
        corrupt,
      ])
    )[0]?.plan_hash,
    scenario: { id: "clean", version: 1 },
  });
  check(
    "G2.stored-hash",
    corruptStart.status === 500 &&
      corruptStart.body.error === "stored_plan_invalid" &&
      (await countRehearsals()) === rehearsalsBeforeCorrupt,
    `${corrupt} (manifest edited under its hash) → ${corruptStart.status} ${corruptStart.body.error}; rehearsal rows ${rehearsalsBeforeCorrupt} → ${await countRehearsals()}`,
  );
  ids.baseline = await rehearse(support, plans.refused.planId, "clean", `t413-baseline-${STAMP}`);
  const baseline = await settled(support, plans.refused.planId, ids.baseline);
  const baselineAttempts = await attemptsOf(ids.baseline);
  check(
    "G2.baseline",
    baseline.state === "failed" &&
      /snapshot|evidence/i.test(baseline.detail ?? "") &&
      baselineAttempts.length === 0 &&
      (await tornDown(ids.baseline)),
    `rehearsal ${ids.baseline} ${baseline.state}: "${baseline.detail}"; attempts ${baselineAttempts.length}`,
  );

  // Nothing from a rehearsal works for operational apply.
  const ap = plans.apply.planId;
  ids.applyRehearsal = await rehearse(support, ap, "clean", `t413-apply-${STAMP}`);
  const applyRehearsal = await settled(support, ap, ids.applyRehearsal);
  const apPlan = await call(support, "GET", `/api/plans/${ap}`);
  const apHash = apPlan.body.planHash as string;
  const withRehearsal = await call(support, "POST", `/api/plans/${ap}/apply`, {
    revision: 1,
    planHash: apHash,
    rehearsalId: ids.applyRehearsal,
  });
  const withRhHash = await call(support, "POST", `/api/plans/${ap}/apply`, {
    revision: 1,
    planHash: `rh_${ids.applyRehearsal}_${apHash}`,
  });
  const noGrant = await call(support, "POST", `/api/plans/${ap}/apply`, {
    revision: 1,
    planHash: apHash,
  });
  const approveWithRehearsal = await call(support, "POST", `/api/plans/${ap}/approvals`, {
    revision: 1,
    planHash: apHash,
    rehearsalId: ids.applyRehearsal,
  });
  const runsAfterRefusals = await sql("select id from runs where plan_id = $1", [ap]);
  check(
    "G2.rehearsal-not-authority",
    applyRehearsal.state === "completed" &&
      withRehearsal.status === 400 &&
      withRhHash.status === 400 &&
      noGrant.status >= 400 &&
      noGrant.status < 500 &&
      approveWithRehearsal.status === 400 &&
      runsAfterRefusals.length === 0,
    `after passed rehearsal ${ids.applyRehearsal}: apply naming it → ${withRehearsal.status}; apply with its rh_ hash → ${withRhHash.status}; apply with no operational grant → ${noGrant.status} ${noGrant.body.error}; approval naming it → ${approveWithRehearsal.status}; runs ${runsAfterRefusals.length}`,
  );

  // Applying the same plan later still runs every operational guard against live state.
  const approvals: string[] = [];
  for (const who of [support, finance]) {
    const a = await call(who, "POST", `/api/plans/${ap}/approvals`, {
      revision: 1,
      planHash: apHash,
    });
    approvals.push(`${who.username} ${a.status}`);
    if (a.status === 201 && (a.body.approval as { satisfied?: boolean } | undefined)?.satisfied)
      break;
  }
  const c01 = records.cases.find((c) => c.key === "c01");
  const template = records.stripe.charges.find((c) => c.id === c01?.chargeIds[1]);
  const phantomId = `ch_INC0927c01t413${STAMP}`;
  await adminOrThrow(await gateWorld("stripe", "operational"), "/inject", {
    charges: [
      {
        ...template,
        id: phantomId,
        created: Date.parse("2026-09-25T09:00:00.000Z") / 1000,
        payment_intent: `pi_${phantomId.slice(3)}`,
        balance_transaction: `txn_${phantomId.slice(3)}`,
        refunds: {
          object: "list",
          data: [],
          has_more: false,
          url: `/v1/charges/${phantomId}/refunds`,
        },
      },
    ],
  });
  const applied = await call(support, "POST", `/api/plans/${ap}/apply`, {
    revision: 1,
    planHash: apHash,
  });
  const runId = applied.body.runId as string;
  const runEvents = await until(
    `run ${runId}`,
    async () => {
      const r = await call(support, "GET", `/api/runs/${runId}/events`);
      const run = r.body.run as { state: string } | undefined;
      return run && !["approved", "applying"].includes(run.state) ? r.body : null;
    },
    180_000,
  );
  const receipts = (runEvents.events as { seq: number; type: string; payload: Receipt }[])
    .filter((e) => e.type === "step.receipt")
    .map((e) => ({ ...e.payload, seq: e.seq }));
  const byAction = Object.fromEntries(receipts.map((r) => [r.actionId, r]));
  const opRefunds = await getJson<{ data: unknown[] }>(
    "stripe",
    await gateWorld("stripe", "operational"),
    `/v1/refunds?charge=${chargeOf(plans.apply, "refund_001")}&limit=100`,
  );
  check(
    "G2.operational-guards",
    applied.status === 202 &&
      (byAction.refund_001?.outcome as string) === "held" &&
      ((byAction.refund_001?.holdReason as { kind?: string } | undefined)?.kind ?? "") ===
        "query_membership_changed" &&
      (byAction.note_001?.outcome as string) === "skipped_dependency" &&
      opRefunds.data.length === 0,
    `approvals ${approvals.join(", ")}; phantom ${phantomId} put in the operational world; run ${runId} ${(runEvents.run as { state: string }).state}: ${receipts.map((r) => `${r.actionId}=${r.outcome}${r.holdReason ? `(${(r.holdReason as { kind: string }).kind})` : ""}#${r.seq}`).join(" ")}; operational refunds on c01 ${opRefunds.data.length}`,
  );

  const revised = await call(support, "POST", `/api/plans/${ap}/revisions`, {
    baseRevision: 1,
    basePlanHash: apHash,
    excludeActionIds: ["refund_002", "note_002"],
  });
  const r2Hash = revised.body.planHash as string;
  const applyR2 = await call(support, "POST", `/api/plans/${ap}/apply`, {
    revision: 2,
    planHash: r2Hash,
  });
  const r2Runs = await sql("select id from runs where plan_hash = $1", [r2Hash]);
  check(
    "G2.revision-needs-approval",
    revised.status === 201 && applyR2.status >= 400 && applyR2.status < 500 && r2Runs.length === 0,
    `revision ${revised.body.revision} (${String(r2Hash).slice(0, 12)}…) → apply without its own approval ${applyR2.status} ${applyR2.body.error}; runs ${r2Runs.length}`,
  );
} catch (err) {
  check("gate.error", false, (err as Error).stack ?? String(err));
} finally {
  await rehearsalFaults(null).catch(() => undefined);
  check(
    "gate.faults-cleared",
    await faultsCleared().catch(() => false),
    "rehearsal containers' faults read back cleared",
  );
  killWorker();
  for (const s of [support, finance, other]) await s.revoke().catch(() => undefined);
  const out = env.GATE_STATE_FILE ?? resolve(tmpdir(), "t413-gate-state.json");
  writeFileSync(out, JSON.stringify({ ...state, results }, null, 2));
  writeFileSync(`${out}.worker.log`, workerLog);
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed; state in ${out}`,
  );
  await db.$client.end();
  process.exitCode = failed.length === 0 ? 0 : 1;
}
