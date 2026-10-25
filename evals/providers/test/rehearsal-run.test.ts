import { randomBytes, randomUUID } from "node:crypto";
import type { Observation, PlanManifest, QueryObservation } from "@rehearsal/contracts";
import {
  type BillingPolicy,
  fingerprint,
  type ProviderPort,
  planHash,
  rehearsalTenant,
} from "@rehearsal/core";
import {
  createDb,
  listRehearsalStepResults,
  loadRehearsal,
  migrateDb,
  type PgBoss,
  type RehearsalRunContext,
  rehearsalReportsFor,
  requestRehearsal,
  runRehearsalJob,
  schema,
  startQueue,
} from "@rehearsal/db";
import {
  STRIPE_CHARGE_PROJECTION,
  stripeChargeProjection,
  stripeWriter,
  type WorldConfig,
  withWriter,
  writeOnly,
  ZENDESK_TICKET_PROJECTION,
  zendeskTicketProjection,
  zendeskWriter,
} from "@rehearsal/providers";
import { billingManifest, FakeClock, INCIDENT, incidentRecords } from "@rehearsal/testkit";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import policy from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import policyV3 from "../../../scenarios/billing/policy.v3.json" with { type: "json" };
import { provisionSnapshot, teardownSnapshot } from "../../../scripts/seed/snapshot";
import { getJson, REHEARSAL_ENABLED } from "../src/harness";

const POLICIES = [policy, policyV3] as unknown as BillingPolicy[];
const records = incidentRecords();
const CASE = (() => {
  const c = records.cases.find((item) => item.key === "c01");
  if (!c) throw new Error("cohort has no c01");
  return c;
})();
const VERSIONS = {
  commit: "0000000",
  engine: "executor@1",
  worker: "rehearsal-runner@0.0.0",
  verifier: "none",
  projections: { stripe: STRIPE_CHARGE_PROJECTION, zendesk: ZENDESK_TICKET_PROJECTION },
  images: {},
};

/** The fixture plan's case_001, pointed at the seeded cohort's c01 as planning evidence. */
function manifestFor(orgId: string, planId: string): PlanManifest {
  const base = billingManifest(planId);
  const charges = records.stripe.charges.filter((c) => c.customer === CASE.customerId);
  const ticket = records.zendesk.tickets.find((t) => t.id === CASE.ticketId) ?? {};
  const obs = (
    id: string,
    kind: "charge" | "ticket",
    projection: Record<string, unknown>,
  ): Observation => ({
    id,
    world: "planning",
    entity: { vendor: kind === "charge" ? "stripe" : "zendesk", kind, id: String(projection.id) },
    projectionVersion: kind === "charge" ? STRIPE_CHARGE_PROJECTION : ZENDESK_TICKET_PROJECTION,
    projection,
    fingerprint: fingerprint(projection),
    capturedAt: "2026-10-24T00:00:00.000Z",
  });
  const projections = Object.fromEntries(
    charges.map((c) => [String(c.id), stripeChargeProjection(c)]),
  );
  const matchingIds = Object.keys(projections).sort();
  const charge = obs("obs_charge", "charge", stripeChargeProjection(charges[1] ?? {}));
  const tick = obs("obs_ticket", "ticket", zendeskTicketProjection(ticket));
  const query: QueryObservation = {
    id: "q_charges",
    world: "planning",
    vendor: "stripe",
    predicate: {
      kind: "stripe.charges.byCustomerInWindow",
      customerId: CASE.customerId,
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

// T3.15 on Era: a stored plan runs model-free in its own disposable tenants. Needs
// `pnpm infra:up:rehearsal`, Postgres, and `ERA_CONFORMANCE=1 ERA_REHEARSAL=1 DB_TESTS=1`.
describe.skipIf(!REHEARSAL_ENABLED || !process.env.DB_TESTS)(
  "execution rehearsal run on Era (T3.15)",
  () => {
    const url =
      process.env.DATABASE_URL ?? "postgres://rehearsal:rehearsal@localhost:5432/rehearsal";
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

    /** Store the plan and request a rehearsal of it; returns the queued job's payload. */
    async function requested(manifest: PlanManifest) {
      const hash = planHash(manifest);
      await db.insert(schema.planVersions).values({
        orgId: manifest.orgId,
        planId: manifest.planId,
        revision: manifest.revision,
        planHash: hash,
        manifest,
      });
      const res = await requestRehearsal(db, boss, {
        orgId: manifest.orgId,
        userId: "user_support",
        idempotencyKey: randomUUID(),
        request: {
          planId: manifest.planId,
          revision: manifest.revision,
          planHash: hash,
          scenario: { id: "clean", version: 1 },
        },
        now: new Date(),
        newId: () => randomBytes(8).toString("hex"),
      });
      if (res.kind !== "accepted") throw new Error(`not accepted: ${res.kind}`);
      const [job] = (
        await db.execute<{ data: unknown }>(
          sql`select data from pgboss.job where name = 'rehearsal' and data->>'rehearsalId' = ${res.rehearsalId}`,
        )
      ).rows;
      return { id: res.rehearsalId, data: job?.data, hash };
    }

    /** A run context whose writers bind to whatever tenants the operator provisions. */
    function context(id: string, worldsOverride?: RehearsalRunContext["worlds"]) {
      const bound: Partial<Record<"stripe" | "zendesk", WorldConfig>> = {};
      const writer = (vendor: "stripe" | "zendesk"): ProviderPort => {
        const lazy = (): ProviderPort => {
          const config = bound[vendor];
          if (!config) throw new Error(`${vendor} not provisioned`);
          const target = {
            world: "rehearsal" as const,
            config,
            authorization: "Bearer rehearsal-run",
          };
          return writeOnly(vendor === "stripe" ? stripeWriter(target) : zendeskWriter(target));
        };
        // Bind after provisioning: the operator mints this rehearsal's tenant tokens.
        return new Proxy({} as ProviderPort, {
          get: (_t, p) => (lazy() as unknown as Record<string | symbol, unknown>)[p],
        });
      };
      const tenant = rehearsalTenant(id);
      const ctx: RehearsalRunContext = {
        db,
        providers: { stripe: writer("stripe"), zendesk: writer("zendesk") },
        worlds: worldsOverride ?? {
          stripe: { world: "rehearsal", tenant },
          zendesk: { world: "rehearsal", tenant },
        },
        clock: new FakeClock(new Date().toISOString()),
        policies: POLICIES,
        newId: (p) => `${p}_${randomUUID()}`,
        versions: VERSIONS,
        evidence: "era_integration",
        provision: async (manifest, rid) => {
          const p = await provisionSnapshot(manifest, rid);
          if (!p.ok) return p;
          Object.assign(bound, p.worlds);
          return { ok: true, notFromEvidence: p.notFromEvidence };
        },
        teardown: async (rid, state) => {
          await teardownSnapshot(rid, state);
        },
        sleep: async () => {},
      };
      return { ctx, bound };
    }

    it("runs the exact stored plan in its own tenants and records results, IDs and a report", async () => {
      const manifest = manifestFor(`org_${randomUUID()}`, `plan_${randomUUID()}`);
      const { id, data } = await requested(manifest);
      const { ctx, bound } = context(id);
      const result = await runRehearsalJob(data, ctx);
      expect(result).toMatchObject({ kind: "ran", state: "completed" });

      const results = await listRehearsalStepResults(db, manifest.orgId, id);
      expect(results.map((r) => [r.actionId, r.outcome]).sort()).toEqual([
        ["note_001", "confirmed"],
        ["patch_001", "confirmed"],
        ["refund_001", "confirmed"],
      ]);
      const refund = results.find((r) => r.actionId === "refund_001");
      expect(refund?.providerRef).toMatchObject({ vendor: "stripe", kind: "refund" });
      expect(refund?.operationKey.startsWith(`rh_${id}_op_`)).toBe(true);
      // The disposable tenant holds the refund; it read back under the rehearsal's own tenant.
      expect(bound.stripe?.tenant).toBe(rehearsalTenant(id));

      const [report] = await rehearsalReportsFor(db, manifest.orgId, manifest.planId);
      expect(report).toMatchObject({
        rehearsalId: id,
        state: "completed",
        verdict: "unknown",
        evidence: "era_integration",
      });
      expect(report?.notFromEvidence.length).toBeGreaterThan(0);
      const stored = await loadRehearsal(db, manifest.orgId, id);
      expect(stored?.state).toBe("completed");
      expect(stored?.tornDown).toBe(true);

      // Nothing operational was touched: no run, attempt, receipt or binding for this plan.
      for (const table of [schema.stepAttempts, schema.stepReceipts, schema.objectBindings]) {
        expect(await db.select().from(table).where(eq(table.orgId, manifest.orgId))).toEqual([]);
      }
      expect(
        await db.select().from(schema.runs).where(eq(schema.runs.orgId, manifest.orgId)),
      ).toEqual([]);
      const attempts = await db
        .select()
        .from(schema.rehearsalAttempts)
        .where(
          and(
            eq(schema.rehearsalAttempts.orgId, manifest.orgId),
            eq(schema.rehearsalAttempts.rehearsalId, id),
          ),
        );
      expect(attempts.length).toBe(3);
      expect(attempts.every((a) => a.state === "confirmed")).toBe(true);

      // A redelivery of the same job finds it claimed and runs nothing.
      expect(await runRehearsalJob(data, context(id).ctx)).toEqual({
        kind: "skipped",
        reason: "rehearsal is completed",
      });
    }, 60_000);

    it("refuses an incompatible baseline before any world is touched", async () => {
      const manifest = manifestFor(`org_${randomUUID()}`, `plan_${randomUUID()}`);
      (manifest.queryObservations[0] as { complete: boolean }).complete = false;
      const { id, data } = await requested(manifest);
      const { ctx, bound } = context(id);
      const result = await runRehearsalJob(data, ctx);
      expect(result).toMatchObject({ kind: "ran", state: "failed", report: null });
      expect(bound).toEqual({});
      expect((await loadRehearsal(db, manifest.orgId, id))?.events.at(-2)?.detail).toMatch(
        /snapshot refused/,
      );
    }, 60_000);

    it("refuses to run when the worlds aren't this rehearsal's own tenants", async () => {
      const manifest = manifestFor(`org_${randomUUID()}`, `plan_${randomUUID()}`);
      const { id, data } = await requested(manifest);
      const { ctx } = context(id, {
        stripe: { world: "operational", tenant: "rehearsal-demo" },
        zendesk: { world: "rehearsal", tenant: rehearsalTenant(id) },
      });
      const result = await runRehearsalJob(data, ctx);
      expect(result).toMatchObject({ kind: "ran", state: "failed" });
      expect(
        await db
          .select()
          .from(schema.rehearsalAttempts)
          .where(eq(schema.rehearsalAttempts.rehearsalId, id)),
      ).toEqual([]);
      expect(result.kind === "ran" && result.report?.limitations.join(" ")).toMatch(
        /not this rehearsal's/,
      );
    }, 60_000);

    it("leaves the planning world's records as they were (the source is never written)", async () => {
      const before = await getJson<{ data: unknown[] }>(
        "stripe",
        {
          baseUrl: process.env.ERA_STRIPE_PLANNING_URL ?? "",
          tenant: process.env.ERA_TENANT ?? "rehearsal-demo",
        },
        `/v1/refunds?charge=${CASE.chargeIds[1]}&limit=100`,
      ).catch(() => null);
      const manifest = manifestFor(`org_${randomUUID()}`, `plan_${randomUUID()}`);
      const { id, data } = await requested(manifest);
      expect((await runRehearsalJob(data, context(id).ctx)).kind).toBe("ran");
      const after = await getJson<{ data: unknown[] }>(
        "stripe",
        {
          baseUrl: process.env.ERA_STRIPE_PLANNING_URL ?? "",
          tenant: process.env.ERA_TENANT ?? "rehearsal-demo",
        },
        `/v1/refunds?charge=${CASE.chargeIds[1]}&limit=100`,
      ).catch(() => null);
      expect(after).toEqual(before);
    }, 60_000);
  },
);
