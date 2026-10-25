import type { Action, QueryObservation } from "@rehearsal/contracts";
import type { BillingPolicy } from "@rehearsal/core";

export interface CoverageIssue {
  kind: "unexamined" | "incomplete_query" | "missing_remedy";
  customerId: string;
  chargeIds: string[];
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
