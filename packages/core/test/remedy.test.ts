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
        priorRemedies: [],
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
        priorRemedies: [],
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
        priorRemedies: [],
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
        priorRemedies: [],
        refundedChargeIds: new Set(),
        credits: [{ id: "cbtxn_1", amountMinor: 100, currency: "usd", chargeId: "ch_1" }],
      }),
    ).toMatchObject({ detail: expect.stringMatching(/cbtxn_1/) });
  });

  it("holds an untagged credit in the same currency that is no larger than the step", () => {
    const other = { id: "cbtxn_2", amountMinor: 12500, currency: "cad", chargeId: null };
    expect(
      oneRemedyHold({
        step: refund,
        settledBy: new Map(),
        priorRemedies: [],
        refundedChargeIds: new Set(),
        credits: [other],
      }),
    ).toBeNull();
    expect(
      oneRemedyHold({
        step: refund,
        settledBy: new Map(),
        priorRemedies: [],
        refundedChargeIds: new Set(),
        credits: [{ ...other, id: "cbtxn_3", amountMinor: 4210 }],
      }),
    ).toMatchObject({ rule: "R5.remedy_already_completed" });
    // A partial credit may be part of this remedy: 2000 plus a 4210 refund would pay 6210.
    expect(
      oneRemedyHold({
        step: refund,
        settledBy: new Map(),
        priorRemedies: [],
        refundedChargeIds: new Set(),
        credits: [{ ...other, id: "cbtxn_4", amountMinor: 2000 }],
      }),
    ).toMatchObject({ detail: expect.stringMatching(/cbtxn_4 of 2000 cad, naming no charge/) });
    expect(
      oneRemedyHold({
        step: refund,
        settledBy: new Map(),
        priorRemedies: [],
        refundedChargeIds: new Set(),
        credits: [{ ...other, id: "cbtxn_5", amountMinor: 2000, currency: "usd" }],
      }),
    ).toBeNull();
  });

  it("holds when another plan or revision sent a remedy for the obligation", () => {
    const sent = { planHash: "sha256:rev1", actionId: "refund_001", attemptId: "att_1" };
    const hold = (state: "confirmed" | "reconciled" | "unknown_outcome" | "dispatched") =>
      oneRemedyHold({
        step: { ...refund, id: "refund_001r", chargeId: "ch_1b" },
        settledBy: new Map(),
        priorRemedies: [{ ...sent, state }],
        refundedChargeIds: new Set(),
        credits: [],
      });
    expect(hold("confirmed")).toMatchObject({
      rule: "R5.remedy_already_completed",
      detail: "obligation obl_1 was already remedied by refund_001 under plan hash sha256:rev1",
    });
    expect(hold("reconciled")).toMatchObject({ rule: "R5.remedy_already_completed" });
    expect(hold("unknown_outcome")).toMatchObject({
      detail: expect.stringMatching(
        /may already have remedied obligation obl_1; attempt att_1 is unknown_outcome/,
      ),
    });
    expect(hold("dispatched")).toMatchObject({ rule: "R5.remedy_already_completed" });
  });

  it("ignores another plan's remedy attempts that did nothing", () => {
    const sent = { planHash: "sha256:rev1", actionId: "refund_001", attemptId: "att_1" };
    expect(
      oneRemedyHold({
        step: refund,
        settledBy: new Map(),
        priorRemedies: [
          { ...sent, state: "rejected" },
          { ...sent, attemptId: "att_2", state: "prepared" },
        ],
        refundedChargeIds: new Set(),
        credits: [],
      }),
    ).toBeNull();
  });

  it("does not treat another obligation's credit as this one", () => {
    expect(
      oneRemedyHold({
        step: refund,
        settledBy: new Map([["obl_other", "refund_earlier"]]),
        priorRemedies: [],
        refundedChargeIds: new Set(["ch_other"]),
        credits: [{ id: "cbtxn_9", amountMinor: 4210, currency: "cad", chargeId: "ch_other" }],
      }),
    ).toBeNull();
  });
});
