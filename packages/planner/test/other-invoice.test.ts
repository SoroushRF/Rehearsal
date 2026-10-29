import { STRIPE_CHARGE_PROJECTION, ZENDESK_TICKET_PROJECTION } from "@rehearsal/providers";
import { type FakeCharge, INCIDENT, incidentRecords } from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import type { PlanningSession } from "../src";
import { executor } from "./apply";
import { world } from "./world";

/**
 * T1.34 (#279), on fakes: the scorecard's B11 drift. After approval, c01 is charged in the window
 * for another invoice. The duplicate pair is unchanged, so the gold expects its refund to go out.
 * This pins what the executor does today: the refund cites the customer's whole in-window query,
 * so any new member holds it. That hold is the false positive T4.28 (#282) removes; when it lands,
 * this test's expectation flips.
 */
const META = {
  orgId: "org_demo",
  incidentId: INCIDENT.incident,
  planId: "plan_other_invoice",
  model: "test",
  promptVersion: "test",
  adapters: { stripe: STRIPE_CHARGE_PROJECTION, zendesk: ZENDESK_TICKET_PROJECTION },
};
const c01 = incidentRecords().cases.find((c) => c.key === "c01");
if (!c01) throw new Error("no c01");
const OTHER = "ch_INC0927c01otherinv";

async function plan(session: PlanningSession) {
  for (const [name, input] of [
    [
      "propose_duplicate_refund",
      { chargeId: c01?.chargeIds[1], duplicateOfChargeId: c01?.chargeIds[0], rationale: "x" },
    ],
    [
      "propose_refund_note",
      { refundStepId: `refund_${c01?.chargeIds[1]}`, ticketId: String(c01?.ticketId) },
    ],
  ] as const) {
    const r = await session.call(name, input);
    if (!r.ok) throw new Error(`${name}: ${r.error}`);
  }
}

describe("a new charge on another of the customer's invoices (T1.34)", () => {
  it("holds the refund today, though its invoice pair is unchanged: the proof T4.28 needs", async () => {
    const planning = world();
    await plan(planning.session);
    const r1 = planning.session.manifest(META);
    const exec = executor(r1);
    const dup = exec.operational.charges.get(c01.chargeIds[1]);
    if (!dup) throw new Error("no duplicate in the operational world");
    exec.operational.charges.set(OTHER, {
      ...dup,
      id: OTHER,
      invoice: "in_INC0927c01other",
      created: Number(dup.created) + 86_400,
    } as FakeCharge);

    const run = await exec.apply(r1);
    const refund = run.receipts.find((r) => r.actionId === `refund_${c01.chargeIds[1]}`);
    expect(refund).toMatchObject({
      outcome: "held",
      holdReason: { kind: "query_membership_changed", added: [OTHER], removed: [] },
    });
    expect(run.receipts.find((r) => r.actionId.startsWith("note_"))?.outcome).toBe(
      "skipped_dependency",
    );
    expect(exec.operational.refunds).toHaveLength(0);
    // The pair itself is exactly as approved: same invoice, same amounts, nothing refunded.
    const approved = r1.queryObservations[0]?.projections;
    for (const id of c01.chargeIds) {
      expect(exec.operational.charges.get(id)).toMatchObject({
        invoice: approved?.[id]?.invoice,
        amount_refunded: 0,
      });
    }
  });
});
