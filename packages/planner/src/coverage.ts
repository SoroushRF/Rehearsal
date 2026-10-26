import type { Action, QueryObservation } from "@rehearsal/contracts";
import type { BillingPolicy } from "@rehearsal/core";

export interface CoverageIssue {
  kind: "unexamined" | "incomplete_query" | "missing_remedy";
  customerId: string;
  chargeIds: string[];
  /** Backlog runs: the waiting tickets nothing followed up. */
  ticketIds?: string[];
}

/** The invoice rule shared by proposing remedies and checking recorded coverage. */
export function duplicateInvoiceGroup(query: QueryObservation, invoice: string) {
  if (query.predicate.kind !== "stripe.charges.byCustomerInWindow" || !query.complete) return null;
  const customer = query.predicate.customerId;
  const gte = Date.parse(query.predicate.createdGte) / 1000;
  const lt = Date.parse(query.predicate.createdLt) / 1000;
  const group = query.matchingIds
    .map((id) => query.projections[id])
    .filter((p) => p?.invoice === invoice);
  const first = group[0];
  if (
    group.length < 2 ||
    !first ||
    group.some(
      (p) =>
        !p ||
        p.customer !== customer ||
        p.currency !== first.currency ||
        p.amount !== first.amount ||
        p.status !== "succeeded" ||
        !Number.isSafeInteger(p.created) ||
        Number(p.created) < gte ||
        Number(p.created) >= lt ||
        p.amount_refunded !== 0,
    )
  )
    return null;
  return [...group].sort(
    (a, b) => Number(a?.created) - Number(b?.created) || String(a?.id).localeCompare(String(b?.id)),
  );
}

/** No provider reads and no model text: only complete, recorded charge queries and typed actions. */
export function assessCoverage(
  customers: readonly string[],
  queries: readonly QueryObservation[],
  actions: readonly Action[],
  policy: BillingPolicy,
): CoverageIssue[] {
  const issues: CoverageIssue[] = [];
  for (const customerId of new Set(customers)) {
    const query = queries.find(
      (q) =>
        q.predicate.kind === "stripe.charges.byCustomerInWindow" &&
        q.predicate.customerId === customerId,
    );
    if (!query) {
      issues.push({ kind: "unexamined", customerId, chargeIds: [] });
      continue;
    }
    if (!query.complete || query.matchingIds.some((id) => !query.projections[id])) {
      issues.push({ kind: "incomplete_query", customerId, chargeIds: [] });
      continue;
    }
    const invoices = new Set(query.matchingIds.map((id) => query.projections[id]?.invoice));
    for (const invoice of invoices) {
      if (typeof invoice !== "string" || !invoice) continue;
      const group = duplicateInvoiceGroup(query, invoice);
      if (!group || group[0]?.currency !== policy.currency) continue;
      for (const charge of group.slice(1)) {
        const chargeId = String(charge?.id);
        const remedied = actions.some(
          (a) =>
            (a.kind === "stripe.refund.create" || a.kind === "stripe.customer.balanceCredit") &&
            a.args.chargeId === chargeId,
        );
        if (!remedied) {
          issues.push({
            kind: "missing_remedy",
            customerId,
            chargeIds: [String(group[0]?.id), chargeId],
          });
        }
      }
    }
  }
  return issues;
}

/**
 * Backlog coverage (live demo, #331): every customer's tickets were listed in full, and every one of
 * their waiting tickets (status `new`, theirs by `external_id`) got a follow-up note.
 */
export function assessBacklogCoverage(
  customers: readonly { customerId: string; requesterId: string }[],
  queries: readonly QueryObservation[],
  actions: readonly Action[],
): CoverageIssue[] {
  const issues: CoverageIssue[] = [];
  for (const { customerId, requesterId } of customers) {
    const listed = queries.filter(
      (q) =>
        q.predicate.kind === "zendesk.tickets.byRequester" &&
        q.predicate.requesterId === requesterId,
    );
    const query = listed.at(-1);
    if (!query) {
      issues.push({ kind: "unexamined", customerId, chargeIds: [] });
      continue;
    }
    if (!query.complete || query.matchingIds.some((id) => !query.projections[id])) {
      issues.push({ kind: "incomplete_query", customerId, chargeIds: [] });
      continue;
    }
    const waiting = query.matchingIds.filter((id) => {
      const t = query.projections[id];
      return t?.status === "new" && t.external_id === customerId;
    });
    const missing = waiting.filter(
      (id) =>
        !actions.some(
          (a) => a.kind === "zendesk.ticket.appendPrivateNote" && a.args.ticketId === id,
        ),
    );
    if (missing.length > 0) {
      issues.push({ kind: "missing_remedy", customerId, chargeIds: [], ticketIds: missing });
    }
  }
  return issues;
}
