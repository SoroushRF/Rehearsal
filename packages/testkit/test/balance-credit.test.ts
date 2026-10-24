import { Action, StripeCustomerBalanceCredit } from "@rehearsal/contracts";
import { describe, expect, it } from "vitest";
import { happyPathBundle } from "../src/bundles";

const refund = happyPathBundle().manifest.actions.find((a) => a.kind === "stripe.refund.create");
if (refund?.kind !== "stripe.refund.create") throw new Error("bundle has no refund");

const credit = {
  ...refund,
  kind: "stripe.customer.balanceCredit",
  args: {
    customerId: "cus_fuWRQh4Ob4dwEN8e",
    chargeId: refund.args.chargeId,
    amount: refund.args.amount,
  },
};

describe("stripe.customer.balanceCredit (T1.19)", () => {
  it("parses a credit of a positive amount against a charge", () => {
    expect(StripeCustomerBalanceCredit.parse(credit).args.amount.amountMinor).toBeGreaterThan(0);
  });

  it("refuses a zero credit, which Era would accept", () => {
    const zero = {
      ...credit,
      args: { ...credit.args, amount: { ...credit.args.amount, amountMinor: 0 } },
    };
    expect(StripeCustomerBalanceCredit.safeParse(zero).success).toBe(false);
  });

  it("is a plannable action (T1.14)", () => {
    expect(Action.safeParse(credit).success).toBe(true);
  });
});
