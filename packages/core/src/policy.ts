import type { Action, Currency, Money, Role } from "@rehearsal/contracts";

/** Authored demo policy for the fictional company — not a financial/regulatory requirement. */
export interface BillingPolicyV1 {
  id: "billing-remedy";
  version: 1;
  currency: Currency;
  /** Refunds at or above this need the finance role. */
  financeThresholdMinor: number;
}

/**
 * Adds the invoice-balance credit as a second remedy (decision 0010). Money still goes back by
 * refund; a credit stays on the customer's account, so only a small amount may be settled that way.
 */
export interface BillingPolicyV2 extends Omit<BillingPolicyV1, "version"> {
  version: 2;
  /** A credit below this is allowed; at or above it the obligation must be refunded. */
  creditMaxMinor: number;
}

export type BillingPolicy = BillingPolicyV1 | BillingPolicyV2;

/**
 * A step policy can judge. The balance credit isn't in `Action` yet (T1.14 adds it once this policy
 * handles it), so a plan can't carry one today; policy reads only the fields below, so it is ready
 * for the day it can. Every `StripeCustomerBalanceCredit` fits.
 */
export type PolicyAction =
  | Action
  | (Pick<Action, "id" | "obligationId" | "requiredRole"> & {
      kind: "stripe.customer.balanceCredit";
      args: { amount: Money };
    });

/** Remedies that already took effect, by obligation, from earlier runs. Supplied by the caller. */
export interface PolicyContext {
  completedRemedies?: ReadonlyMap<string, { actionId: string }>;
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

/** The money-back steps. Exactly one may settle an obligation. */
function remedyAmount(a: PolicyAction): Money | null {
  return a.kind === "stripe.refund.create" || a.kind === "stripe.customer.balanceCredit"
    ? a.args.amount
    : null;
}

export function evaluateBillingPolicy(
  manifest: { actions: readonly PolicyAction[] },
  policy: BillingPolicy,
  context: PolicyContext = {},
): PolicyResult {
  const violations: PolicyViolation[] = [];
  const requiredRoles = new Set<Role>();
  const remedyByObligation = new Map<string, string>();
  const creditMax = policy.version === 2 ? policy.creditMaxMinor : null;

  for (const a of manifest.actions) {
    requiredRoles.add(a.requiredRole);
    const amount = remedyAmount(a);
    if (!amount) continue;
    const isCredit = a.kind === "stripe.customer.balanceCredit";
    const noun = isCredit ? "credit" : "refund";

    // R4: which remedies this policy version knows about, and how large a credit may be.
    if (isCredit) {
      if (creditMax === null) {
        violations.push({
          rule: "R4.remedy_not_allowed",
          actionId: a.id,
          detail: `policy ${policy.id}@${policy.version} has no invoice credit; use a refund`,
        });
      } else if (amount.amountMinor >= creditMax) {
        violations.push({
          rule: "R4.credit_over_limit",
          actionId: a.id,
          detail: `credit of ${amount.amountMinor} is not below ${creditMax}; refund it instead`,
        });
      }
    }

    if (amount.currency !== policy.currency) {
      violations.push({
        rule: "R1.currency",
        actionId: a.id,
        detail: `${noun} in ${amount.currency}, policy allows ${policy.currency}`,
      });
    }

    const prior = remedyByObligation.get(a.obligationId);
    if (prior) {
      violations.push({
        rule: "R2.single_remedy",
        actionId: a.id,
        detail: `obligation ${a.obligationId} already remedied by ${prior}`,
      });
    } else {
      remedyByObligation.set(a.obligationId, a.id);
    }

    // R5: a remedy that already took effect, in an earlier run, settles the obligation for good.
    const done = context.completedRemedies?.get(a.obligationId);
    if (done) {
      violations.push({
        rule: "R5.remedy_already_completed",
        actionId: a.id,
        detail: `obligation ${a.obligationId} was already remedied by ${done.actionId}`,
      });
    }

    if (amount.amountMinor >= policy.financeThresholdMinor && a.requiredRole !== "finance_lead") {
      violations.push({
        rule: "R3.finance_threshold",
        actionId: a.id,
        detail: `${noun} of ${amount.amountMinor} needs finance_lead`,
      });
    }
  }
  return { violations, requiredRoles };
}
