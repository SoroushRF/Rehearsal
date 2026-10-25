import type { Action, AttemptState, HoldReason } from "@rehearsal/contracts";

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

/**
 * The remedy an action is, or null. Every action kind is listed, so a new kind (the balance credit
 * of T1.14) can't reach the guard as "not a remedy" without someone deciding that here.
 */
export function remedyOf(action: Action): RemedyStep | null {
  switch (action.kind) {
    case "stripe.refund.create":
      return {
        id: action.id,
        obligationId: action.obligationId,
        kind: action.kind,
        chargeId: action.args.chargeId,
        amountMinor: action.args.amount.amountMinor,
        currency: action.args.amount.currency,
      };
    case "zendesk.ticket.patchFields":
    case "zendesk.ticket.appendPrivateNote":
    case "zendesk.ticket.appendPublicReply":
    case "slack.message.postSummary":
      return null;
    default: {
      const unhandled: never = action;
      throw new Error(`no remedy rule for ${(unhandled as Action).kind}`);
    }
  }
}

/** Another remedy step's attempt for the same obligation, from any plan or revision. */
export interface PriorRemedyAttempt {
  planHash: string;
  actionId: string;
  attemptId: string;
  state: AttemptState;
}

/** Applied, or sent with an outcome nobody has resolved yet. Prepared and refused rows did nothing. */
const BLOCKING: ReadonlySet<AttemptState> = new Set([
  "dispatched",
  "unknown_outcome",
  "confirmed",
  "reconciled",
]);

export interface OneRemedyInput {
  step: RemedyStep;
  /** Confirmed remedies from this plan, obligation id to the action that settled it. */
  settledBy: ReadonlyMap<string, string>;
  /** Other remedy attempts for this obligation across the org's plans and revisions. */
  priorRemedies: readonly PriorRemedyAttempt[];
  /** Charges whose fresh read shows a refund this plan's evidence and own writes don't explain. */
  refundedChargeIds: ReadonlySet<string>;
  credits: readonly SeenCredit[];
}

function violation(detail: string): HoldReason {
  return { kind: "policy_violation", rule: "R5.remedy_already_completed", detail };
}

/**
 * Hold a refund or credit when that obligation already has a remedy: one we confirmed, one sent
 * under another plan or revision (even if its outcome is still unknown), a refund now on its
 * charge, or a balance credit for that charge. A credit that names no charge holds when its
 * currency matches and it is no larger than the step: it may be part of this remedy, and on a
 * money path a person decides. A credit for a different charge, or a larger one, does not match.
 */
export function oneRemedyHold(input: OneRemedyInput): HoldReason | null {
  const { step } = input;
  const prior = input.settledBy.get(step.obligationId);
  if (prior !== undefined && prior !== step.id) {
    return violation(`obligation ${step.obligationId} was already remedied by ${prior}`);
  }
  const other = input.priorRemedies.find((item) => BLOCKING.has(item.state));
  if (other) {
    const settled = other.state === "confirmed" || other.state === "reconciled";
    return violation(
      settled
        ? `obligation ${step.obligationId} was already remedied by ${other.actionId} under plan hash ${other.planHash}`
        : `${other.actionId} under plan hash ${other.planHash} may already have remedied obligation ${step.obligationId}; attempt ${other.attemptId} is ${other.state}`,
    );
  }
  if (input.refundedChargeIds.has(step.chargeId)) {
    return violation(`charge ${step.chargeId} already has a refund`);
  }
  const credit = input.credits.find(
    (item) =>
      item.chargeId === step.chargeId ||
      (item.chargeId === null &&
        item.currency === step.currency &&
        item.amountMinor <= step.amountMinor),
  );
  if (credit) {
    const which =
      credit.chargeId === null
        ? `of ${credit.amountMinor} ${credit.currency}, naming no charge,`
        : `for charge ${credit.chargeId}`;
    return violation(
      `balance credit ${credit.id} ${which} may already cover obligation ${step.obligationId}`,
    );
  }
  return null;
}
