import { type Action, PositiveMoney } from "@rehearsal/contracts";

/** A refund may release a confirmation only for the exact successful approved effect. */
export function refundEffectMatches(
  action: Extract<Action, { kind: "stripe.refund.create" }>,
  effect: Record<string, unknown>,
): boolean {
  const money = PositiveMoney.safeParse({
    amountMinor: effect["refund.amount"],
    currency: effect.currency,
  });
  return (
    money.success &&
    typeof effect["refund.id"] === "string" &&
    effect["refund.id"].length > 0 &&
    effect["refund.status"] === "succeeded" &&
    effect.charge === action.args.chargeId &&
    money.data.amountMinor === action.args.amount.amountMinor &&
    money.data.currency === action.args.amount.currency
  );
}

/**
 * What sending needs of a `stripe.customer.balanceCredit` action (contracts'
 * `StripeCustomerBalanceCredit`, in `Action` since T1.14).
 */
export interface CreditAction {
  id: string;
  kind: "stripe.customer.balanceCredit";
  args: { customerId: string; chargeId: string; amount: { amountMinor: number; currency: string } };
}

/**
 * A balance credit may confirm only as the exact approved credit: a negative `adjustment` balance
 * transaction on that customer, naming the charge it remedies, for that amount and currency (T3.12).
 */
export function creditEffectMatches(
  action: CreditAction,
  effect: Record<string, unknown>,
): boolean {
  return (
    typeof effect["credit.id"] === "string" &&
    effect["credit.id"].length > 0 &&
    effect["credit.type"] === "adjustment" &&
    effect.customer === action.args.customerId &&
    effect["credit.charge"] === action.args.chargeId &&
    effect["credit.amount"] === -action.args.amount.amountMinor &&
    effect.currency === action.args.amount.currency
  );
}
