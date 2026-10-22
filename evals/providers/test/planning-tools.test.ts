import { PlanManifest } from "@rehearsal/contracts";
import { evaluateBillingPolicy, validateGraph } from "@rehearsal/core";
import { PlanningSession } from "@rehearsal/planner";
import { eraAdmin, stripeReader, zendeskReader } from "@rehearsal/providers";
import { INCIDENT, incidentRecords } from "@rehearsal/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminToken,
  ENABLED,
  resetScratchTenants,
  scratchWorld,
  uniqueTenant,
} from "../src/harness";

const POLICY = {
  id: "billing-remedy",
  version: 1,
  currency: "cad",
  financeThresholdMinor: 10_000,
} as const;

// T1.4: the typed planning tools over the real read adapters, against the seeded INC-BILL-0927
// cohort in a scratch tenant of the planning world. Every action they build must parse as
// contracts v1 and pass the graph and policy checks.
describe.skipIf(!ENABLED)("planning tools on the seeded cohort", () => {
  const tenant = uniqueTenant("tools");
  const records = incidentRecords();
  let session: PlanningSession;

  beforeAll(async () => {
    const stripe = await scratchWorld("stripe", "planning", tenant);
    const zendesk = await scratchWorld("zendesk", "planning", tenant);
    for (const [world, body] of [
      [stripe, records.stripe],
      [zendesk, records.zendesk],
    ] as const) {
      const res = await eraAdmin(world, adminToken(), "/inject", body);
      if (!res.ok) throw new Error(`inject → ${res.status} ${await res.text()}`);
    }
    session = new PlanningSession({
      readers: {
        stripe: stripeReader({
          world: "planning",
          config: stripe,
          authorization: "Bearer sk_test_plan",
        }),
        zendesk: zendeskReader({
          world: "planning",
          config: zendesk,
          authorization: "Bearer plan",
        }),
      },
      ctx: { world: "planning", tenant },
      policy: POLICY,
      window: INCIDENT.window,
    });
  });

  afterAll(resetScratchTenants);

  it("finds each duplicate pair and refuses every control", async () => {
    for (const c of records.cases) {
      const listed = await session.call("list_customer_charges", { customerId: c.customerId });
      expect(listed.ok).toBe(true);
      const refund = await session.call("propose_duplicate_refund", {
        chargeId: c.chargeIds[1],
        duplicateOfChargeId: c.chargeIds[0],
        rationale: `Second charge for ${c.invoices[1]} under ${INCIDENT.incident}.`,
      });
      expect(refund.ok, `${c.key} ${c.kind}`).toBe(c.kind === "duplicate");
      if (!refund.ok) continue;
      const ticketId = String(c.ticketId);
      for (const [name, input] of [
        [
          "propose_ticket_priority",
          { customerId: c.customerId, ticketId, priority: "high", rationale: "In flight." },
        ],
        ["propose_refund_note", { refundStepId: `refund_${c.chargeIds[1]}`, ticketId }],
      ] as const) {
        const r = await session.call(name, input);
        expect(r, `${c.key} ${name}`).toMatchObject({ ok: true });
      }
    }
  });

  it("compiles a manifest that matches contracts v1 and passes graph and policy", () => {
    const manifest = session.manifest({
      orgId: "org_demo",
      incidentId: INCIDENT.incident,
      planId: "plan_tools_live",
      model: "none",
      promptVersion: "none",
      adapters: { stripe: "stripe.charge.v2", zendesk: "zendesk.ticket.v2" },
    });
    expect(PlanManifest.parse(manifest)).toEqual(manifest);
    const duplicates = records.cases.filter((c) => c.kind === "duplicate");
    expect(manifest.actions).toHaveLength(duplicates.length * 3);
    expect(validateGraph(manifest.actions)).toEqual([]);
    expect(evaluateBillingPolicy(manifest, POLICY).violations).toEqual([]);
    expect(manifest.queryObservations.every((q) => q.complete && q.world === "planning")).toBe(
      true,
    );
    const finance = manifest.actions.filter((a) => a.requiredRole === "finance_lead");
    expect(finance.map((a) => a.kind)).toEqual(
      duplicates.filter((c) => c.amountMinor >= 10_000).map(() => "stripe.refund.create"),
    );
  });
});
