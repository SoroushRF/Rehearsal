import type { Observation, PlanManifest, QueryObservation } from "@rehearsal/contracts";
import {
  type BillingPolicyV1,
  createReadGuard,
  type ExecutorDeps,
  executeRun,
  type ProviderPort,
  planHash,
} from "@rehearsal/core";
import {
  eraAdmin,
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
  INCIDENT,
  incidentRecords,
  MemoryApplyStore,
  MemoryJournal,
  phantomBundle,
  type SeededCase,
} from "@rehearsal/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import policy from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import { seedIncident } from "../../../scripts/seed/incident";
import {
  adminToken,
  ENABLED,
  type EraVendor,
  getComments,
  getJson,
  getTicket,
  resetScratchTenants,
  resetTenant,
  scratchWorld,
  uniqueTenant,
  vendorFetch,
} from "../src/harness";

const records = incidentRecords();
const PHANTOM_ID = "ch_INC0927c01phantom";
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
 * T4.3 gate: the `phantom` bundle on real Era. The plan is built from planning-world reads of the
 * seeded cohort. After approval a new in-window duplicate charge appears for c01 in the operational
 * world only. The executor, with the read guard, holds c01's refund, skips its note, and applies c02.
 */
describe.skipIf(!ENABLED)("phantom charge on Era", () => {
  const tenant = uniqueTenant("phantom");
  const worlds = {} as Record<EraVendor, { planning: WorldConfig; operational: WorldConfig }>;
  let manifest: PlanManifest;

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
      authorization: "Bearer sk_test_phantom",
    });
    const zendesk = zendeskReader({
      world: "planning",
      config: worlds.zendesk.planning,
      authorization: "Bearer phantom",
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
    const base = billingManifest(`plan_phantom_${tenant}`);
    manifest = {
      ...base,
      observations,
      queryObservations,
      actions: base.actions.map((a) => {
        const copy = structuredClone(a);
        const c = CASES[a.caseId.slice(-3) as "001" | "002"];
        if (copy.kind === "stripe.refund.create") copy.args.chargeId = c.chargeIds[1];
        else copy.args.ticketId = String(c.ticketId);
        return copy;
      }),
    };

    // After approval: a third in-window charge for c01 lands in the operational world only.
    const template = records.stripe.charges.find((ch) => ch.id === CASES["001"].chargeIds[1]);
    const phantom = {
      ...template,
      id: PHANTOM_ID,
      created: Math.floor(Date.parse("2026-09-25T09:00:00Z") / 1000),
      refunds: {
        object: "list",
        data: [],
        has_more: false,
        url: `/v1/charges/${PHANTOM_ID}/refunds`,
      },
    };
    const res = await eraAdmin(worlds.stripe.operational, adminToken(), "/inject", {
      charges: [phantom],
    });
    if (!res.ok) throw new Error(`inject → ${res.status} ${await res.text()}`);
  });

  afterAll(resetScratchTenants);

  it("holds c01's refund on the new charge, skips its note, and applies c02", async () => {
    const hash = planHash(manifest);
    const store = new MemoryApplyStore();
    store.runs.set("run_phantom", {
      planId: manifest.planId,
      revision: 1,
      planHash: hash,
      approvalId: "g",
    });
    store.plans.set(`${manifest.planId}@1`, { planHash: hash, manifest });
    store.grants.set("g", {
      id: "g",
      orgId: manifest.orgId,
      planId: manifest.planId,
      revision: 1,
      planHash: hash,
      actorUserId: "user_finance",
      actorSessionId: "sess",
      roles: ["support_lead", "finance_lead"],
      grantedAt: "2026-10-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      revokedAt: null,
    });
    const clock = new FakeClock("2026-10-21T12:00:00.000Z");
    const op = (vendor: EraVendor) => ({
      world: "operational" as const,
      config: worlds[vendor].operational,
      authorization: vendor === "stripe" ? "Bearer sk_test_phantom" : "Bearer phantom",
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
    const deps: ExecutorDeps = {
      store,
      journal: new MemoryJournal(),
      clock,
      providers,
      worlds: operational,
      policies: [policy as BillingPolicyV1],
      newId: (p) => `${p}_${++n}`,
      guard: createReadGuard({ providers, worlds: operational, clock }),
    };

    const result = await executeRun(
      {
        orgId: manifest.orgId,
        runId: "run_phantom",
        planId: manifest.planId,
        revision: 1,
        planHash: hash,
      },
      deps,
    );

    expect(result.error).toBeNull();
    expect(Object.fromEntries(result.receipts.map((r) => [r.actionId, r.outcome]))).toEqual(
      Object.fromEntries(phantomBundle().expected.map((e) => [e.actionId, e.outcome])),
    );
    expect(result.receipts.find((r) => r.actionId === "refund_001")?.holdReason).toEqual({
      kind: "query_membership_changed",
      queryObservationId: "q_charges_001",
      added: [PHANTOM_ID],
      removed: [],
    });
    expect(result.state).toBe("partial");

    // The operational world agrees: no refund for c01 at all, exactly one for c02's duplicate.
    const refundsOn = async (world: WorldConfig, chargeIds: readonly string[]) => {
      const found: string[] = [];
      for (const id of chargeIds) {
        const list = await getJson<{ data: unknown[] }>(
          "stripe",
          world,
          `/v1/refunds?charge=${id}&limit=100`,
        );
        found.push(...list.data.map(() => id));
      }
      return found;
    };
    expect(
      await refundsOn(worlds.stripe.operational, [...CASES["001"].chargeIds, PHANTOM_ID]),
    ).toEqual([]);
    expect(await refundsOn(worlds.stripe.operational, CASES["002"].chargeIds)).toEqual([
      CASES["002"].chargeIds[1],
    ]);

    // c01 got its priority patch but no note; c02 got both.
    const c01 = CASES["001"].ticketId;
    const c02 = CASES["002"].ticketId;
    expect((await getTicket(worlds.zendesk.operational, c01)).priority).toBe("high");
    expect((await getComments(worlds.zendesk.operational, c01)).some((c) => !c.public)).toBe(false);
    expect((await getComments(worlds.zendesk.operational, c02)).some((c) => !c.public)).toBe(true);

    // The planning world never saw the phantom or any of our writes.
    expect(
      (await vendorFetch("stripe", worlds.stripe.planning, `/v1/charges/${PHANTOM_ID}`)).status,
    ).toBe(404);
    expect(
      await refundsOn(worlds.stripe.planning, [
        ...CASES["001"].chargeIds,
        ...CASES["002"].chargeIds,
      ]),
    ).toEqual([]);
  });
});
