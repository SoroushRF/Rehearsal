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
