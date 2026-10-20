import type { Currency, PlanManifest, Role } from "@rehearsal/contracts";

/** Authored demo policy for the fictional company — not a financial/regulatory requirement. */
export interface BillingPolicyV1 {
  id: "billing-remedy";
  version: 1;
  currency: Currency;
  /** Refunds at or above this need the finance role. */
  financeThresholdMinor: number;
}

export interface PolicyViolation {
  rule: string;
  actionId: string;
  detail: string;
}

export interface PolicyResult {
  violations: PolicyViolation[];
  requiredRoles: Set<Role>;
}

export function evaluateBillingPolicy(
  manifest: PlanManifest,
  policy: BillingPolicyV1,
): PolicyResult {
  const violations: PolicyViolation[] = [];
  const requiredRoles = new Set<Role>();
  const refundsByObligation = new Map<string, string>();

  for (const a of manifest.actions) {
    requiredRoles.add(a.requiredRole);
    if (a.kind !== "stripe.refund.create") continue;

    if (a.args.amount.currency !== policy.currency) {
      violations.push({
        rule: "R1.currency",
        actionId: a.id,
        detail: `refund in ${a.args.amount.currency}, policy allows ${policy.currency}`,
      });
    }

    const prior = refundsByObligation.get(a.obligationId);
    if (prior) {
      violations.push({
        rule: "R2.single_remedy",
        actionId: a.id,
        detail: `obligation ${a.obligationId} already remedied by ${prior}`,
      });
    } else {
      refundsByObligation.set(a.obligationId, a.id);
    }

    if (
      a.args.amount.amountMinor >= policy.financeThresholdMinor &&
      a.requiredRole !== "finance_lead"
    ) {
      violations.push({
        rule: "R3.finance_threshold",
        actionId: a.id,
        detail: `refund of ${a.args.amount.amountMinor} needs finance_lead`,
      });
    }
  }
  return { violations, requiredRoles };
}
