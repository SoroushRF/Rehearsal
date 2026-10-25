import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Observation, PlanManifest, QueryObservation } from "@rehearsal/contracts";
import { type BillingPolicy, fingerprint } from "@rehearsal/core";
import { createDb, migrateDb, type PgBoss, startQueue } from "@rehearsal/db";
import {
  REHEARSAL_WORKER_FORBIDDEN,
  STRIPE_CHARGE_PROJECTION,
  stripeChargeProjection,
  ZENDESK_TICKET_PROJECTION,
  zendeskTicketProjection,
} from "@rehearsal/providers";
import { billingManifest, INCIDENT, incidentRecords } from "@rehearsal/testkit";
import policyV1 from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import policyV2 from "../../../scenarios/billing/policy.v2.json" with { type: "json" };
import policyV3 from "../../../scenarios/billing/policy.v3.json" with { type: "json" };
import { buildApp } from "../../api/src/app";
import type { IamClient } from "../../api/src/iam";
import { storePlan } from "../../api/src/plans";
import { rehearsalTenantActive } from "../../api/src/rehearsal-operator";
import { rehearsalTokenDepsFromEnv } from "../../api/src/rehearsal-tokens";
import { type Caller, caller, fakeIam } from "../../api/test/fake-iam";

/** What stays on the API and IAM, removed from what the worker inherits. */
const NOT_FOR_THE_WORKER = [
  ...REHEARSAL_WORKER_FORBIDDEN,
  "CLERK_SECRET_KEY",
  "IAM_URL",
  "IAM_CLIENT_CERT",
  "IAM_CLIENT_KEY",
  "IAM_TLS_CERT",
  "IAM_TLS_KEY",
  "IAM_TLS_CLIENT_CA",
];

/**
 * A real execution-rehearsal stack for tests: the API's own routes on real Postgres and pg-boss,
 * its operator and mint routes holding the rehearsal admin token, and the rehearsal worker as its
 * own process (`src/main.ts`) with none of the API's credentials. Only IAM is a stand-in: it runs
 * the real rule file over people the test registers. Needs `pnpm infra:up:rehearsal`.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const POLICIES = [policyV1, policyV2, policyV3] as unknown as BillingPolicy[];
const records = incidentRecords();

/**
 * case_001 of the fixture plan, pointed at the seeded cohort's c01 with v2 evidence, so the seeder
 * can rebuild it. `refused` leaves the cited charge out of the query that should list it: the
 * seeded tenant then reads back a charge the plan's evidence says isn't there, and the snapshot is
 * refused before anything runs.
 */
export function rehearsablePlan(orgId: string, planId: string, opts: { refused?: boolean } = {}) {
  const c01 = records.cases.find((c) => c.key === "c01");
  if (!c01) throw new Error("cohort has no c01");
  const charges = records.stripe.charges.filter((c) => c.customer === c01.customerId);
  const ticket = records.zendesk.tickets.find((t) => t.id === c01.ticketId) ?? {};
  const obs = (id: string, kind: "charge" | "ticket", projection: Record<string, unknown>) =>
    ({
      id,
      world: "planning",
      entity: { vendor: kind === "charge" ? "stripe" : "zendesk", kind, id: String(projection.id) },
      projectionVersion: kind === "charge" ? STRIPE_CHARGE_PROJECTION : ZENDESK_TICKET_PROJECTION,
      projection,
      fingerprint: fingerprint(projection),
      capturedAt: "2026-10-24T00:00:00.000Z",
    }) as Observation;
  const charge = obs("obs_charge", "charge", stripeChargeProjection(charges[1] ?? {}));
  const tick = obs("obs_ticket", "ticket", zendeskTicketProjection(ticket));
  const listed = opts.refused ? charges.filter((c) => c.id !== charge.entity.id) : charges;
  const projections = Object.fromEntries(
    listed.map((c) => [String(c.id), stripeChargeProjection(c)]),
  );
  const matchingIds = Object.keys(projections).sort();
  const query: QueryObservation = {
    id: "q_charges",
    world: "planning",
    vendor: "stripe",
    predicate: {
      kind: "stripe.charges.byCustomerInWindow",
      customerId: c01.customerId,
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
  const base = billingManifest(planId);
  const actions = base.actions
    .filter((a) => a.caseId === "case_001")
    .map((a) => {
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
      return copy;
    });
  return {
    ...base,
    orgId,
    observations: [charge, tick],
    queryObservations: [query],
    actions,
  } as PlanManifest;
}

export interface Stack {
  url: string;
  /** Register a support lead in a fresh org, optionally with a stored plan. Returns their token. */
  org(
    orgId: string,
    userIds: string[],
    plan?: { planId: string; refused?: boolean },
  ): Promise<Record<string, string>>;
  /** The worker's output so far, for a failing test to show. */
  workerLog(): string;
  stop(): Promise<void>;
}

/** Everything the worker must not see, removed from what it inherits; then only what it needs. */
function workerEnv(env: NodeJS.ProcessEnv, apiUrl: string, secret: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env };
  for (const k of NOT_FOR_THE_WORKER) delete out[k];
  return {
    ...out,
    DATABASE_URL: env.DATABASE_URL,
    REHEARSAL_API_URL: apiUrl,
    REHEARSAL_WORKER_SECRET: secret,
    ERA_STRIPE_REHEARSAL_URL: env.ERA_STRIPE_REHEARSAL_URL,
    ERA_ZENDESK_REHEARSAL_URL: env.ERA_ZENDESK_REHEARSAL_URL,
  };
}

export async function startStack(env: NodeJS.ProcessEnv = process.env): Promise<Stack> {
  const dbUrl = env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set");
  const db = createDb(dbUrl);
  await migrateDb(db);
  const boss: PgBoss = await startQueue(dbUrl);
  const secret = randomBytes(24).toString("hex");
  const apiEnv = { ...env, REHEARSAL_WORKER_SECRET: secret };

  const people: Caller[] = [];
  const iam: IamClient = {
    decide: (r) => fakeIam(people).decide(r),
    identify: (t) => fakeIam(people).identify(t),
    membership: (c) => fakeIam(people).membership(c),
  };
  const rehearsalTokens = rehearsalTokenDepsFromEnv((id) => rehearsalTenantActive(db, id), apiEnv);
  if (!rehearsalTokens) throw new Error("REHEARSAL_ERA_ADMIN_TOKEN is not set");
  const app = buildApp({
    webRoot: null,
    iam,
    plans: { db, iam },
    approvals: { db, iam, policies: POLICIES },
    runs: { db, iam },
    executionRehearsals: { db, boss, iam },
    rehearsalTokens,
    rehearsalOperator: { db, secret },
  });
  const url = await app.listen({ port: 0, host: "127.0.0.1" });

  const tsx = createRequire(import.meta.url).resolve("tsx/cli");
  const worker: ChildProcess = spawn(process.execPath, [tsx, "apps/rehearsal-worker/src/main.ts"], {
    cwd: ROOT,
    env: workerEnv(env, url, secret),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  worker.stdout?.on("data", (d: Buffer) => {
    log += d.toString();
  });
  worker.stderr?.on("data", (d: Buffer) => {
    log += d.toString();
  });
  const ready = await new Promise<boolean>((done) => {
    const timer = setTimeout(() => done(false), 60_000);
    const check = () => {
      if (log.includes("rehearsal-worker consuming")) {
        clearTimeout(timer);
        done(true);
      }
    };
    worker.stdout?.on("data", check);
    worker.once("exit", () => {
      clearTimeout(timer);
      done(false);
    });
  });

  const stop = async () => {
    if (worker.exitCode === null && worker.pid !== undefined) {
      if (process.platform === "win32")
        spawnSync("taskkill", ["/pid", String(worker.pid), "/T", "/F"]);
      else worker.kill("SIGTERM");
    }
    await app.close();
    await boss.stop({ graceful: false });
    await db.$client.end();
  };
  if (!ready) {
    await stop();
    throw new Error(`the rehearsal worker didn't start:\n${log}`);
  }

  return {
    url,
    async org(orgId, userIds, plan) {
      const tokens: Record<string, string> = {};
      for (const userId of userIds) {
        const person = caller(orgId, "org:support_lead", userId);
        people.push(person);
        tokens[userId] = person.token;
      }
      if (plan && !(await storePlan(db, rehearsablePlan(orgId, plan.planId, plan)))) {
        throw new Error("plan not stored");
      }
      return tokens;
    },
    workerLog: () => log,
    stop,
  };
}
