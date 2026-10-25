import type {
  Action,
  Money,
  Observation,
  PlanManifest,
  QueryObservation,
} from "@rehearsal/contracts";

/** One customer branch of the plan, as the reviewer sees it. */
export interface CaseGroup {
  caseId: string;
  /** Stripe customer the case is about, read from its evidence; null if none was observed. */
  customerId: string | null;
  actions: Action[];
  /** Money going back to the customer's card. */
  refunds: Money[];
  /** Money kept on the customer's account as a credit against their next invoice. */
  credits: Money[];
}

/** Groups actions by case, keeping manifest order inside each case and between cases. */
export function groupByCase(manifest: PlanManifest): CaseGroup[] {
  const groups = new Map<string, CaseGroup>();
  for (const a of manifest.actions) {
    let g = groups.get(a.caseId);
    if (!g) {
      g = { caseId: a.caseId, customerId: null, actions: [], refunds: [], credits: [] };
      groups.set(a.caseId, g);
    }
    g.actions.push(a);
    if (a.kind === "stripe.refund.create") g.refunds.push(a.args.amount);
    if (a.kind === "stripe.customer.balanceCredit") g.credits.push(a.args.amount);
  }
  for (const g of groups.values()) g.customerId = customerOf(manifest, g.actions);
  return [...groups.values()];
}

function customerOf(manifest: PlanManifest, actions: readonly Action[]): string | null {
  const queryIds = new Set(actions.flatMap((a) => a.queryEvidence));
  for (const q of manifest.queryObservations) {
    if (queryIds.has(q.id) && q.predicate.kind === "stripe.charges.byCustomerInWindow") {
      return q.predicate.customerId;
    }
  }
  // A charge names its customer; a ticket carries the Stripe customer ID as `external_id` (the
  // fixtures put it in `requester_id`). This keeps the name when a case's refund is excluded.
  const obsIds = new Set(actions.flatMap((a) => a.evidence));
  for (const o of manifest.observations) {
    if (!obsIds.has(o.id)) continue;
    const { customer, external_id, requester_id } = o.projection;
    for (const id of [customer, external_id, requester_id]) {
      if (typeof id === "string" && id.startsWith("cus_")) return id;
    }
  }
  return null;
}

export interface ActionEvidence {
  observations: Observation[];
  queries: QueryObservation[];
  /** Evidence IDs the action cites that the manifest doesn't contain. Should always be empty. */
  missing: string[];
}

export function evidenceFor(manifest: PlanManifest, action: Action): ActionEvidence {
  const obs = new Map(manifest.observations.map((o) => [o.id, o]));
  const queries = new Map(manifest.queryObservations.map((q) => [q.id, q]));
  const missing: string[] = [];
  const pick = <T>(ids: readonly string[], from: Map<string, T>) =>
    ids.flatMap((id) => {
      const found = from.get(id);
      if (!found) missing.push(id);
      return found ? [found] : [];
    });
  return {
    observations: pick(action.evidence, obs),
    queries: pick(action.queryEvidence, queries),
    missing,
  };
}

/**
 * The unchecked actions plus everything that depends on them, for previewing an exclusion before
 * it is sent. Mirrors `excludeActions` in `@rehearsal/core`; the server's revision is what counts.
 * A run summary only counts steps, so it isn't a dependent: it goes when it is unchecked itself,
 * or once one of its counts has no step left.
 */
export function droppedBy(actions: readonly Action[], unchecked: Iterable<string>): Set<string> {
  const dropped = new Set(unchecked);
  let grew = true;
  while (grew) {
    grew = false;
    for (const a of actions) {
      if (a.kind === "slack.message.postSummary") continue;
      if (!dropped.has(a.id) && a.dependsOn.some((d) => dropped.has(d))) {
        dropped.add(a.id);
        grew = true;
      }
    }
  }
  for (const a of actions) {
    if (a.kind !== "slack.message.postSummary" || dropped.has(a.id)) continue;
    const counts = Object.values(a.args.bindings).filter((b) => typeof b === "object");
    if (counts.some((b) => b.stepIds.every((id) => dropped.has(id)))) dropped.add(a.id);
  }
  return dropped;
}

/** Which roles have to sign this plan, strongest first. */
export function requiredRoles(manifest: PlanManifest): Action["requiredRole"][] {
  const roles = new Set(manifest.actions.map((a) => a.requiredRole));
  return (["finance_lead", "support_lead"] as const).filter((r) => roles.has(r));
}
