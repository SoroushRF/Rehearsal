import { renderNote, renderReply } from "@rehearsal/core";
import { describe, expect, it } from "vitest";
import { type CaseReads, judgeCase, records } from "../src/world";

/** T1.32: exact-effect readback, per charge, per currency, per note text. */
const found = records.cases.find((c) => c.key === "c01");
if (!found) throw new Error("no c01");
const c01 = found;
const [original, duplicate] = c01.chargeIds;
const amount = c01.amountMinor;
const marked = (body: string) => `${body}\n\n[rehearsal-op:op_test]`;
const note = (refundId: string) =>
  renderNote({ id: "refund-confirmed", version: 1 }, { refundId, amountMinor: amount }, "op_test");
const reply = marked(
  renderReply({ id: "refund-issued", version: 1 }, { customerName: c01.name, amountMinor: amount }),
);

/** c01 remedied exactly as approved: our refund on the duplicate, its note and its reply. */
function correct(): CaseReads {
  return {
    refunds: [{ id: "re_1", charge: duplicate, amount, currency: c01.currency, ours: true }],
    credits: [],
    priority: "high",
    comments: [
      { public: true, body: "Original ticket text." },
      { public: false, body: note("re_1") },
      { public: true, body: reply },
    ],
  };
}

describe("exact-effect readback (T1.32)", () => {
  it("reads the approved effects as correct", () => {
    expect(note("re_1")).toMatch(/\[rehearsal-op:op_test\]$/);
    expect(judgeCase(c01, correct())).toEqual({
      refunds: 1,
      credits: 0,
      priority: "high",
      notes: 1,
      replies: 1,
      incorrect: 0,
    });
  });

  it("calls a refund of the wrong charge of the same customer incorrect", () => {
    const reads = correct();
    reads.refunds = [{ id: "re_1", charge: original, amount, currency: c01.currency, ours: true }];
    expect(judgeCase(c01, reads)).toMatchObject({ refunds: 1, incorrect: 1 });
    // A teammate's refund of the original isn't ours, so it isn't a wrong-charge refund of ours.
    reads.refunds = [
      { id: "re_1", charge: duplicate, amount, currency: c01.currency, ours: true },
      { id: "re_t", charge: original, amount, currency: c01.currency, ours: false },
    ];
    expect(judgeCase(c01, reads)).toMatchObject({ refunds: 2, incorrect: 0 });
  });

  it("calls a refund in another currency incorrect", () => {
    const reads = correct();
    reads.refunds = [{ id: "re_1", charge: duplicate, amount, currency: "usd", ours: true }];
    expect(judgeCase(c01, reads).incorrect).toBe(1);
  });

  it("checks each note's text against the template and the refund it names", () => {
    const reads = correct();
    reads.comments = reads.comments.map((x) =>
      x.public ? x : { ...x, body: marked("Refund issued, all good.") },
    );
    expect(judgeCase(c01, reads).incorrect).toBe(1);
    // A note naming a refund this case doesn't have is wrong too.
    const other = correct();
    other.comments = other.comments.map((x) => (x.public ? x : { ...x, body: note("re_other") }));
    expect(judgeCase(c01, other).incorrect).toBe(1);
  });

  it("accepts a credit and its credit note and reply (T1.39)", () => {
    const credit = renderNote(
      { id: "credit-applied", version: 1 },
      { amountMinor: amount },
      "op_test",
    );
    const creditReply = marked(
      renderReply(
        { id: "credit-applied", version: 1 },
        { customerName: c01.name, amountMinor: amount },
      ),
    );
    expect(
      judgeCase(c01, {
        refunds: [],
        credits: [{ amount: -amount, currency: c01.currency }],
        priority: "high",
        comments: [
          { public: false, body: credit },
          { public: true, body: creditReply },
        ],
      }),
    ).toMatchObject({ credits: 1, notes: 1, replies: 1, incorrect: 0 });
  });
});
