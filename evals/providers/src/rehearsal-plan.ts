import type { Observation, PlanManifest, QueryObservation } from "@rehearsal/contracts";
import { fingerprint } from "@rehearsal/core";
import {
  STRIPE_CHARGE_PROJECTION,
  stripeChargeProjection,
  ZENDESK_TICKET_PROJECTION,
  zendeskTicketProjection,
} from "@rehearsal/providers";
import { billingManifest, INCIDENT, incidentRecords } from "@rehearsal/testkit";

/** A plan the rehearsal seeder supports, for the rehearsal Era suites (T3.15, T3.16). */
const records = incidentRecords();
export const CASE = (() => {
  const c = records.cases.find((item) => item.key === "c01");
  if (!c) throw new Error("cohort has no c01");
  return c;
})();

/** The fixture plan's case_001, pointed at the seeded cohort's c01 as planning evidence. */
export function manifestFor(orgId: string, planId: string): PlanManifest {
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
