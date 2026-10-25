import type { Observation, PlanManifest, QueryObservation } from "@rehearsal/contracts";
import {
  type BillingPolicyV1,
  createReadGuard,
  type ExecutorDeps,
  executeRun,
  type ProviderPort,
  planHash,
  readRemedyHold,
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
  stripePost,
  uniqueTenant,
} from "../src/harness";

const records = incidentRecords();
const CASES: Record<"001" | "002", SeededCase> = {
  "001": cohortCase("c01"),
  "002": cohortCase("c02"),
};

function cohortCase(key: string): SeededCase {
  const found = records.cases.find((item) => item.key === key);
  if (!found) throw new Error(`cohort has no case ${key}`);
  return found;
}

/**
 * T4.10 on Era. A balance credit for c01's duplicate, applied after approval, holds that refund.
 * c02 has no credit and still refunds. A refund already on a charge holds a credit of that charge.
 */
describe.skipIf(!ENABLED)("one remedy per obligation on Era", () => {
  const tenant = uniqueTenant("remedy");
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
    const ctx = { world: "planning", tenant } as const;
    const stripe = stripeReader({
      world: "planning",
      config: worlds.stripe.planning,
      authorization: "Bearer sk_test_remedy",
    });
    const zendesk = zendeskReader({
      world: "planning",
      config: worlds.zendesk.planning,
      authorization: "Bearer remedy",
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
    const base = billingManifest(`plan_remedy_${tenant}`);
    manifest = {
      ...base,
      observations,
      queryObservations,
      actions: base.actions.map((action) => {
        const copy = structuredClone(action);
        const c = CASES[action.caseId.slice(-3) as "001" | "002"];
        if (copy.kind === "stripe.refund.create") copy.args.chargeId = c.chargeIds[1];
        else if (copy.kind !== "slack.message.postSummary") copy.args.ticketId = String(c.ticketId);
        return copy;
      }),
    };

    const c01 = CASES["001"];
    const body = `amount=-${c01.amountMinor}&currency=usd&metadata[charge]=${c01.chargeIds[1]}`;
    const posted = await stripePost(
      worlds.stripe.operational,
      `/v1/customers/${c01.customerId}/balance_transactions`,
      body,
      `remedy-${tenant}`,
    );
    if (!posted.ok) throw new Error(`credit → ${posted.status} ${await posted.text()}`);
  });

  afterAll(resetScratchTenants);

  it("holds the credited customer's refund and applies the other", async () => {
    const hash = planHash(manifest);
    const store = new MemoryApplyStore();
    store.runs.set("run_remedy", {
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
      authorization: vendor === "stripe" ? "Bearer sk_test_remedy" : "Bearer remedy",
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
      newId: (prefix) => `${prefix}_${++n}`,
      guard: createReadGuard({ providers, worlds: operational, clock }),
    };
    const result = await executeRun(
      {
        orgId: manifest.orgId,
        runId: "run_remedy",
        planId: manifest.planId,
        revision: 1,
        planHash: hash,
      },
      deps,
    );

    expect(result.error).toBeNull();
    expect(result.receipts.find((receipt) => receipt.actionId === "refund_001")).toMatchObject({
      outcome: "held",
      holdReason: { kind: "policy_violation", rule: "R5.remedy_already_completed" },
    });
    expect(result.receipts.find((receipt) => receipt.actionId === "refund_002")?.outcome).toBe(
      "confirmed",
    );
    const c01Refunds = await getJson<{ data: unknown[] }>(
      "stripe",
      worlds.stripe.operational,
      `/v1/refunds?charge=${CASES["001"].chargeIds[1]}&limit=100`,
    );
    expect(c01Refunds.data).toEqual([]);

    const refunded = await stripePost(
      worlds.stripe.operational,
      "/v1/refunds",
      `charge=${CASES["001"].chargeIds[1]}&amount=${CASES["001"].amountMinor}&reason=duplicate`,
      `refund-${tenant}`,
    );
    if (!refunded.ok) throw new Error(`refund → ${refunded.status} ${await refunded.text()}`);
    const held = await readRemedyHold(
      deps,
      {
        id: "credit_001",
        obligationId: "obl_overcharge_001",
        kind: "stripe.customer.balanceCredit",
        chargeId: CASES["001"].chargeIds[1],
        amountMinor: CASES["001"].amountMinor,
        currency: "cad",
      },
      { manifest, confirmedReceipts: [], priorRemedies: [] },
    );
    expect(held).toMatchObject({
      kind: "policy_violation",
      rule: "R5.remedy_already_completed",
      detail: expect.stringMatching(/already has a refund/),
    });
  });
});
