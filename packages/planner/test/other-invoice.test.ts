import { STRIPE_CHARGE_PROJECTION, ZENDESK_TICKET_PROJECTION } from "@rehearsal/providers";
import { INCIDENT, incidentRecords } from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import type { PlanningSession } from "../src";
import { executor } from "./apply";
import { world } from "./world";

/**
 * T1.34 (#279), on fakes: the scorecard's B11 drift. After approval, c01 is charged in the window
 * for another invoice. The duplicate pair is unchanged, so the gold expects its refund to go out.
 * Before T4.28 (#282) the refund held, because it compared the customer's whole in-window query.
 * It now compares the refunded invoice's charges only, so a third charge on that invoice still
 * holds it.
 */
const META = {
  orgId: "org_demo",
  incidentId: INCIDENT.incident,
  planId: "plan_other_invoice",
  model: "test",
  promptVersion: "test",
  adapters: { stripe: STRIPE_CHARGE_PROJECTION, zendesk: ZENDESK_TICKET_PROJECTION },
};
const c01 = (() => {
  const found = incidentRecords().cases.find((c) => c.key === "c01");
  if (!found) throw new Error("no c01");
  return found;
})();
const OTHER = "ch_INC0927c01otherinv";

async function plan(session: PlanningSession) {
  for (const [name, input] of [
    [
      "propose_duplicate_refund",
      { chargeId: c01.chargeIds[1], duplicateOfChargeId: c01.chargeIds[0], rationale: "x" },
    ],
    [
      "propose_refund_note",
      { refundStepId: `refund_${c01.chargeIds[1]}`, ticketId: String(c01.ticketId) },
    ],
  ] as const) {
    const r = await session.call(name, input);
    if (!r.ok) throw new Error(`${name}: ${r.error}`);
  }
}

/** Approve the c01 plan, then charge c01 again in the window on `invoice` (the pair's own if null). */
async function applyAfterNewCharge(invoice: string | null) {
  const planning = world();
  await plan(planning.session);
  const r1 = planning.session.manifest(META);
  const exec = executor(r1);
  const dup = exec.operational.charges.get(c01.chargeIds[1]);
  if (!dup) throw new Error("no duplicate in the operational world");
  exec.operational.charges.set(OTHER, {
    ...dup,
    id: OTHER,
    invoice: invoice ?? dup.invoice,
    created: Number(dup.created) + 86_400,
  });
  return { r1, exec, run: await exec.apply(r1) };
}

describe("a new charge on another of the customer's invoices (T1.34)", () => {
  it("lets the refund go out: its invoice pair is unchanged (T4.28)", async () => {
    const { r1, exec, run } = await applyAfterNewCharge("in_INC0927c01other");
    const approved = r1.queryObservations[0]?.projections;
    expect(approved?.[c01.chargeIds[1]]?.invoice).toEqual(expect.any(String));
    expect(approved?.[c01.chargeIds[1]]?.invoice).not.toBe("in_INC0927c01other");

    const refund = run.receipts.find((r) => r.actionId === `refund_${c01.chargeIds[1]}`);
    expect(refund).toMatchObject({ outcome: "confirmed", holdReason: null });
    expect(run.receipts.find((r) => r.actionId.startsWith("note_"))?.outcome).toBe("confirmed");
    expect(exec.operational.refunds).toHaveLength(1);
    expect(exec.operational.refunds[0]).toMatchObject({ charge: c01.chargeIds[1] });
  });

  it("still holds the refund on a third charge of the same invoice", async () => {
    const { exec, run } = await applyAfterNewCharge(null);
    const refund = run.receipts.find((r) => r.actionId === `refund_${c01.chargeIds[1]}`);
    expect(refund).toMatchObject({
      outcome: "held",
      holdReason: { kind: "query_membership_changed", added: [OTHER], removed: [] },
    });
    expect(run.receipts.find((r) => r.actionId.startsWith("note_"))?.outcome).toBe(
      "skipped_dependency",
    );
    expect(exec.operational.refunds).toHaveLength(0);
  });
});
