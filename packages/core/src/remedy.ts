import type { HoldReason } from "@rehearsal/contracts";

/**
 * A negative customer balance transaction: an invoice credit. `chargeId` is set only when the
 * transaction itself names the charge. Without that, the amount and currency are the only link.
 */
export interface SeenCredit {
  id: string;
  amountMinor: number;
  currency: string;
  chargeId: string | null;
}

/** A refund or a balance credit. One of them settles an obligation. */
export interface RemedyStep {
  id: string;
  obligationId: string;
  kind: "stripe.refund.create" | "stripe.customer.balanceCredit";
  chargeId: string;
  amountMinor: number;
  currency: string;
}

export interface OneRemedyInput {
  step: RemedyStep;
  /** Confirmed remedies from this plan, obligation id to the action that settled it. */
  settledBy: ReadonlyMap<string, string>;
  /** Charges whose fresh read already shows a refund. */
  refundedChargeIds: ReadonlySet<string>;
  credits: readonly SeenCredit[];
}

function violation(detail: string): HoldReason {
  return { kind: "policy_violation", rule: "R5.remedy_already_completed", detail };
}

/**
 * Hold a refund or credit when that obligation already has a remedy: one we confirmed, a refund
 * now on its charge, or a balance credit for that charge (or, with no charge named, the same
 * amount and currency). A credit for a different charge, or a different amount, does not match.
 */
export function oneRemedyHold(input: OneRemedyInput): HoldReason | null {
  const { step } = input;
  const prior = input.settledBy.get(step.obligationId);
  if (prior !== undefined && prior !== step.id) {
    return violation(`obligation ${step.obligationId} was already remedied by ${prior}`);
  }
  if (input.refundedChargeIds.has(step.chargeId)) {
    return violation(`charge ${step.chargeId} already has a refund`);
  }
  const credit = input.credits.find(
    (item) =>
      item.chargeId === step.chargeId ||
      (item.chargeId === null &&
        item.amountMinor === step.amountMinor &&
        item.currency === step.currency),
  );
  if (credit) {
    const which =
      credit.chargeId === null
        ? `of ${credit.amountMinor} ${credit.currency}`
        : `for charge ${credit.chargeId}`;
    return violation(
      `balance credit ${credit.id} ${which} already covers obligation ${step.obligationId}`,
    );
  }
  return null;
}
