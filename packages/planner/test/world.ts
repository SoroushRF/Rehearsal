import type { QueryPredicate } from "@rehearsal/contracts";
import { fingerprint } from "@rehearsal/core";
import {
  STRIPE_CHARGE_PROJECTION,
  stripeChargeProjection,
  ZENDESK_TICKET_PROJECTION,
  zendeskTicketProjection,
} from "@rehearsal/providers";
import { FakeClock, INCIDENT, incidentRecords } from "@rehearsal/testkit";
import { type PlanningReader, PlanningSession, type PlanningSessionOptions } from "../src";

export const POLICY = {
  id: "billing-remedy",
  version: 1,
  currency: "cad",
  financeThresholdMinor: 10_000,
} as const;
export const CTX = { world: "planning", tenant: "t1-4" } as const;

/** In-memory planning world over the seeded cohort, with the real read projections. */
export function world(opts: Pick<PlanningSessionOptions, "runSummary" | "customerNames"> = {}) {
  const records = incidentRecords();
  const charges = new Map(records.stripe.charges.map((c) => [String(c.id), c]));
  const tickets = new Map(records.zendesk.tickets.map((t) => [String(t.id), t]));
  const reads: string[] = [];
  const at = new Date().toISOString();
  const stripe: PlanningReader = {
    vendor: "stripe",
    async observe(entity) {
      reads.push(`charge ${entity.id}`);
      const c = charges.get(entity.id);
      if (!c) throw new Error(`GET /v1/charges/${entity.id} → 404`);
      const projection = stripeChargeProjection(c);
      return {
        id: `obs_charge_${entity.id}`,
        world: "planning",
        entity,
        projectionVersion: STRIPE_CHARGE_PROJECTION,
        projection,
        fingerprint: fingerprint(projection),
        capturedAt: at,
      };
    },
    async query(predicate: QueryPredicate, cutoff) {
      if (predicate.kind !== "stripe.charges.byCustomerInWindow") throw new Error("unsupported");
      reads.push(`charges ${predicate.customerId}`);
      const gte = Date.parse(predicate.createdGte) / 1000;
      const lt = Date.parse(predicate.createdLt) / 1000;
      const hits = [...charges.values()].filter(
        (c) =>
          c.customer === predicate.customerId && Number(c.created) >= gte && Number(c.created) < lt,
      );
      const matchingIds = hits.map((c) => String(c.id)).sort();
      const projections = Object.fromEntries(
        hits.map((c) => [String(c.id), stripeChargeProjection(c)]),
      );
      return {
        id: `q_${fingerprint(predicate).slice(0, 16)}`,
        world: "planning",
        vendor: "stripe",
        predicate,
        cutoff,
        complete: true,
        matchingIds,
        projectionVersion: STRIPE_CHARGE_PROJECTION,
        projections,
        fingerprint: fingerprint({ matchingIds, projections }),
        capturedAt: at,
      };
    },
  };
  const zendesk: PlanningReader = {
    vendor: "zendesk",
    async observe(entity) {
      reads.push(`ticket ${entity.id}`);
      const t = tickets.get(entity.id);
      if (!t) throw new Error(`GET /api/v2/tickets/${entity.id}.json → 404`);
      const projection = zendeskTicketProjection(t);
      return {
        id: `obs_ticket_${entity.id}`,
        world: "planning",
        entity,
        projectionVersion: ZENDESK_TICKET_PROJECTION,
        projection,
        fingerprint: fingerprint(projection),
        capturedAt: at,
      };
    },
    async query() {
      throw new Error("not used");
    },
  };
  const session = new PlanningSession({
    readers: { stripe, zendesk },
    ctx: CTX,
    policy: POLICY,
    window: INCIDENT.window,
    clock: new FakeClock("2026-10-02T12:00:00.000Z"),
    ...opts,
  });
  return { session, reads, records, charges, tickets };
}
