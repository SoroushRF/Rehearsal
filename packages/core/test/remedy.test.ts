import { describe, expect, it } from "vitest";
import { oneRemedyHold, type RemedyStep } from "../src/remedy";

const refund: RemedyStep = {
  id: "refund_001",
  obligationId: "obl_1",
  kind: "stripe.refund.create",
  chargeId: "ch_1",
  amountMinor: 4210,
  currency: "cad",
};
const credit: RemedyStep = { ...refund, id: "credit_001", kind: "stripe.customer.balanceCredit" };

describe("one remedy per obligation", () => {
  it("admits a refund when nothing has settled it", () => {
    expect(
      oneRemedyHold({
        step: refund,
        settledBy: new Map(),
        refundedChargeIds: new Set(),
        credits: [],
      }),
    ).toBeNull();
  });

  it("holds a second remedy once this plan confirmed one", () => {
    expect(
      oneRemedyHold({
        step: credit,
        settledBy: new Map([["obl_1", "refund_001"]]),
        refundedChargeIds: new Set(),
        credits: [],
      }),
    ).toMatchObject({
      kind: "policy_violation",
      rule: "R5.remedy_already_completed",
    });
  });

  it("holds a credit when the charge already has a refund", () => {
    expect(
      oneRemedyHold({
        step: credit,
        settledBy: new Map(),
        refundedChargeIds: new Set(["ch_1"]),
        credits: [],
      }),
    ).toMatchObject({ detail: expect.stringMatching(/ch_1 already has a refund/) });
  });

  it("holds a refund when a credit names its charge", () => {
    expect(
      oneRemedyHold({
        step: refund,
        settledBy: new Map(),
        refundedChargeIds: new Set(),
        credits: [{ id: "cbtxn_1", amountMinor: 100, currency: "usd", chargeId: "ch_1" }],
      }),
    ).toMatchObject({ detail: expect.stringMatching(/cbtxn_1/) });
  });

  it("holds an untagged credit only when the amount and currency match", () => {
    const other = { id: "cbtxn_2", amountMinor: 12500, currency: "cad", chargeId: null };
    expect(
      oneRemedyHold({
        step: refund,
        settledBy: new Map(),
        refundedChargeIds: new Set(),
        credits: [other],
      }),
    ).toBeNull();
    expect(
      oneRemedyHold({
        step: refund,
        settledBy: new Map(),
        refundedChargeIds: new Set(),
        credits: [{ ...other, id: "cbtxn_3", amountMinor: 4210 }],
      }),
    ).toMatchObject({ rule: "R5.remedy_already_completed" });
  });

  it("does not treat another obligation's credit as this one", () => {
    expect(
      oneRemedyHold({
        step: refund,
        settledBy: new Map([["obl_other", "refund_earlier"]]),
        refundedChargeIds: new Set(["ch_other"]),
        credits: [{ id: "cbtxn_9", amountMinor: 4210, currency: "cad", chargeId: "ch_other" }],
      }),
    ).toBeNull();
  });
});
