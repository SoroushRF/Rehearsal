import type { Observation, PlanManifest, QueryObservation } from "@rehearsal/contracts";
import {
  type BillingPolicyV1,
  createReadGuard,
  type ExecutorDeps,
  executeRun,
  type ProviderPort,
  planHash,
  type RegistrySnapshot,
} from "@rehearsal/core";
import {
  stripeReader,
  stripeWriter,
  type WorldConfig,
  withWriter,
  zendeskReader,
  zendeskWriter,
} from "@rehearsal/providers";
import {
  billingManifest,
  FakeClock,
  fakeRunAdmit,
  INCIDENT,
  incidentRecords,
  MemoryApplyStore,
  MemoryJournal,
  type SeededCase,
} from "@rehearsal/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import policy from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import { seedIncident } from "../../../scripts/seed/incident";
import {
  ENABLED,
  type EraVendor,
  getJson,
  resetScratchTenants,
  resetTenant,
  scratchWorld,
  uniqueTenant,
} from "../src/harness";

const records = incidentRecords();
const _PHANTOM_ID = "ch_INC0927c01phantom";
/** The fixture plan's two cases match cohort c01 (42.10 CAD) and c02 (125.00 CAD, finance). */
const CASES: Record<"001" | "002", SeededCase> = {
  "001": cohortCase("c01"),
  "002": cohortCase("c02"),
};

function cohortCase(key: string): SeededCase {
  const c = records.cases.find((item) => item.key === key);
  if (!c) throw new Error(`cohort has no case ${key}`);
  return c;
}

/**
 * #234 on real Era: a plan that cites a precedent is only admitted while Postgres' registry still
 * backs it. The plan is built from planning-world reads of the seeded cohort, as the planner's tools
 * would record it, and carries a basis citing `dup-refund` v1. Nothing here reads Agent Memory.
 */
describe.skipIf(!ENABLED)("precedent citations at admission on Era", () => {
  const tenant = uniqueTenant("precedent");
  const worlds = {} as Record<EraVendor, { planning: WorldConfig; operational: WorldConfig }>;
  let manifest: PlanManifest;
  const AREA = "billing.duplicate_charge";
  const DIGEST = "d".repeat(64);

  beforeAll(async () => {
    for (const vendor of ["stripe", "zendesk"] as const) {
      worlds[vendor] = {
        planning: await scratchWorld(vendor, "planning", tenant),
        operational: await scratchWorld(vendor, "operational", tenant),
      };
      for (const world of ["planning", "operational"] as const) {
        await resetTenant(worlds[vendor][world]);
        await seedIncident(vendor, worlds[vendor][world]);
      }
    }

    // Plan: evidence captured from the planning world, as the planner's tools would record it.
    const ctx = { world: "planning", tenant } as const;
    const stripe = stripeReader({
      world: "planning",
      config: worlds.stripe.planning,
      authorization: "Bearer sk_test_precedent",
    });
    const zendesk = zendeskReader({
      world: "planning",
      config: worlds.zendesk.planning,
      authorization: "Bearer precedent",
    });
    const observations: Observation[] = [];
    const queryObservations: QueryObservation[] = [];
    for (const [n, c] of Object.entries(CASES)) {
      const charge = await stripe.observe(
        { vendor: "stripe", kind: "charge", id: c.chargeIds[1] },
        ctx,
      );
      const ticket = await zendesk.observe(
        { vendor: "zendesk", kind: "ticket", id: String(c.ticketId) },
        ctx,
      );
      const query = await stripe.query(
        { kind: "stripe.charges.byCustomerInWindow", customerId: c.customerId, ...INCIDENT.window },
        new Date().toISOString(),
        ctx,
      );
      observations.push({ ...charge, id: `obs_charge_${n}` }, { ...ticket, id: `obs_ticket_${n}` });
      queryObservations.push({ ...query, id: `q_charges_${n}` });
    }
    const base = billingManifest(`plan_precedent_${tenant}`);
    manifest = {
      ...base,
      observations,
      queryObservations,
      actions: base.actions.map((a) => {
        const copy = structuredClone(a);
        const c = CASES[a.caseId.slice(-3) as "001" | "002"];
        if (copy.kind === "stripe.refund.create") copy.args.chargeId = c.chargeIds[1];
        else if ("ticketId" in copy.args) copy.args.ticketId = String(c.ticketId);
        return copy;
      }),
    };
    manifest = {
      ...manifest,
      precedentBasis: {
        citations: [
          {
            id: "dup-refund",
            version: 1,
            digest: DIGEST,
            appliesTo: AREA,
            factIds: ["fact_1"],
            traceId: "trace_1",
          },
        ],
        epochs: { [AREA]: 0 },
      },
    };
  });

  afterAll(resetScratchTenants);

  /** The registry as Postgres would report it. */
  const registry = (version: number, epoch = 0): RegistrySnapshot => ({
    active: new Map([["dup-refund", { version, digest: DIGEST }]]),
    epochs: new Map([[AREA, epoch]]),
  });

  async function run(
    plan: PlanManifest,
    precedents: ExecutorDeps["precedents"],
  ): Promise<Awaited<ReturnType<typeof executeRun>>> {
    // A fresh operational world each time, so one case's writes never decide the next.
    for (const vendor of ["stripe", "zendesk"] as const) {
      await resetTenant(worlds[vendor].operational);
      await seedIncident(vendor, worlds[vendor].operational);
    }
    const hash = planHash(plan);
    const runId = `run_${Math.random().toString(36).slice(2)}`;
    const store = new MemoryApplyStore();
    store.runs.set(runId, { planId: plan.planId, revision: 1, planHash: hash, approvalId: "g" });
    store.plans.set(`${plan.planId}@1`, { planHash: hash, manifest: plan });
    store.grants.set("g", {
      id: "g",
      orgId: plan.orgId,
      planId: plan.planId,
      revision: 1,
      planHash: hash,
      actorUserId: "user_finance",
      actorSessionId: "sess",
      roles: ["support_lead", "finance_lead"],
      permissions: ["rehearsal:approve:support_step", "rehearsal:approve:finance_step"],
      authzRule: { id: "rehearsal-authz", version: 1 },
      grantedAt: "2026-10-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      revokedAt: null,
    });
    const clock = new FakeClock("2026-10-21T12:00:00.000Z");
    const op = (vendor: EraVendor) => ({
      world: "operational" as const,
      config: worlds[vendor].operational,
      authorization: vendor === "stripe" ? "Bearer sk_test_precedent" : "Bearer precedent",
    });
    const providers: Record<EraVendor, ProviderPort> = {
      stripe: withWriter(stripeReader(op("stripe")), stripeWriter(op("stripe"))),
      zendesk: withWriter(zendeskReader(op("zendesk")), zendeskWriter(op("zendesk"))),
    };
    const operational = {
      stripe: { world: "operational", tenant },
      zendesk: { world: "operational", tenant },
    } as const;
    let n = 0;
    return executeRun(
      { orgId: plan.orgId, runId, planId: plan.planId, revision: 1, planHash: hash },
      {
        store,
        journal: new MemoryJournal(),
        clock,
        providers,
        worlds: operational,
        policies: [policy as BillingPolicyV1],
        admit: fakeRunAdmit({ now: () => new Date("2026-10-22T12:00:00.000Z") }),
        newId: (p) => `${p}_${++n}`,
        guard: createReadGuard({ providers, worlds: operational, clock }),
        ...(precedents && { precedents }),
      },
    );
  }

  const refundsFor = async (chargeIds: readonly string[]) => {
    let found = 0;
    for (const id of chargeIds) {
      const list = await getJson<{ data: unknown[] }>(
        "stripe",
        worlds.stripe.operational,
        `/v1/refunds?charge=${id}&limit=100`,
      );
      found += list.data.length;
    }
    return found;
  };
  const allCharges = [...CASES["001"].chargeIds, ...CASES["002"].chargeIds];

  it("sends nothing once v2 is active and the plan cited v1", async () => {
    const result = await run(manifest, { snapshot: async () => registry(2) });
    expect(result.refusal).toContain("superseded");
    expect(result.receipts).toEqual([]);
    expect(await refundsFor(allCharges)).toBe(0);
  });

  it("sends nothing when the area's epoch moved or the precedent was withdrawn", async () => {
    const moved = await run(manifest, { snapshot: async () => registry(1, 1) });
    expect(moved.refusal).toContain("precedent changed since approval");
    const withdrawn = await run(manifest, {
      snapshot: async () => ({ active: new Map(), epochs: new Map([[AREA, 0]]) }),
    });
    expect(withdrawn.refusal).toContain("withdrawn");
    expect(await refundsFor(allCharges)).toBe(0);
  });

  it("refuses, sending nothing, when the registry can't be read", async () => {
    const result = await run(manifest, {
      snapshot: async () => {
        throw new Error("postgres is down");
      },
    });
    expect(result.refusal).toContain("precedent registry unavailable");
    expect(await refundsFor(allCharges)).toBe(0);
  });

  it("applies the plan while the cited version is still the active one", async () => {
    const result = await run(manifest, { snapshot: async () => registry(1) });
    expect(result.error).toBeNull();
    expect(result.state).toBe("completed");
    expect(await refundsFor(allCharges)).toBe(2);
  });

  it("leaves a plan that cites nothing alone, even if the registry can't be read", async () => {
    const { precedentBasis: _basis, ...plain } = manifest;
    const result = await run(plain, {
      snapshot: async () => {
        throw new Error("postgres is down");
      },
    });
    expect(result.error).toBeNull();
    expect(result.state).toBe("completed");
    expect(await refundsFor(allCharges)).toBe(2);
  });
});
