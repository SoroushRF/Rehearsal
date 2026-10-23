import type { Action, Receipt, ReceiptOutcome } from "@rehearsal/contracts";
import { compensationTargets, decideUndo, inversePatch } from "@rehearsal/core";
import { billingManifest } from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";

type Patch = Extract<Action, { kind: "zendesk.ticket.patchFields" }>;

const manifest = billingManifest("plan_comp");
const patch = (set: Patch["args"]["set"], before: Patch["args"]["before"]): Patch => {
  const base = manifest.actions.find((a) => a.id === "patch_002") as Patch;
  return { ...base, args: { ticketId: "5532", set, before } };
};

const receipt = (actionId: string, outcome: ReceiptOutcome, status?: number): Receipt => ({
  id: `rcp_${actionId}_${outcome}`,
  actionId,
  planHash: "h",
  approvalId: "g",
  outcome,
  providerRef: null,
  observedEffect: status === undefined ? {} : { status },
  protection: "native_guard_with_documented_limits",
  holdReason: null,
  limitations: [],
  recordedAt: "2026-10-21T12:00:00.000Z",
});

describe("decideUndo", () => {
  it("reverts a field that still holds our value", () => {
    expect(
      decideUndo(patch({ priority: "high" }, { priority: "normal" }), { priority: "high" }),
    ).toEqual({ revert: { priority: "normal" }, kept: {}, unrevertable: [] });
  });

  it("keeps a field someone else changed, and still reverts the one that is ours", () => {
    const action = patch(
      { priority: "high", status: "pending" },
      { priority: "normal", status: "open" },
    );
    expect(decideUndo(action, { priority: "urgent", status: "pending" })).toEqual({
      revert: { status: "open" },
      kept: { priority: "urgent" },
      unrevertable: [],
    });
  });

  it("can't write back an empty priority", () => {
    expect(
      decideUndo(patch({ priority: "high" }, { priority: null }), { priority: "high" }),
    ).toEqual({ revert: {}, kept: {}, unrevertable: ["priority"] });
  });

  it("builds the inverse of only the reverted fields", () => {
    const action = patch(
      { priority: "high", status: "pending" },
      { priority: "normal", status: "open" },
    );
    expect(inversePatch(action, { status: "open" }).args).toEqual({
      ticketId: "5532",
      set: { status: "open" },
      before: { status: "pending" },
    });
  });
});

describe("compensationTargets", () => {
  const confirmedCase2 = (note: ReceiptOutcome): Map<string, ReceiptOutcome> =>
    new Map([
      ["refund_002", "confirmed"],
      ["patch_002", "confirmed"],
      ["note_002", note],
      ["patch_001", "confirmed"],
    ]);

  it("targets only the confirmed patch of a case with a definite refusal", () => {
    const ids = compensationTargets(manifest, confirmedCase2("rejected"), [
      receipt("note_002", "rejected", 422),
    ]).map((a) => a.id);
    expect(ids).toEqual(["patch_002"]);
  });

  it.each([
    ["a throttle", 429],
    ["a server error", 503],
  ])("ignores %s, which a later run may send again", (_name, status) => {
    expect(
      compensationTargets(manifest, confirmedCase2("rejected"), [
        receipt("note_002", "rejected", status),
      ]),
    ).toEqual([]);
  });

  it("ignores held and unknown steps, and patches already compensated", () => {
    expect(compensationTargets(manifest, confirmedCase2("held"), [])).toEqual([]);
    expect(compensationTargets(manifest, confirmedCase2("unknown_outcome"), [])).toEqual([]);
    expect(
      compensationTargets(manifest, confirmedCase2("rejected"), [
        receipt("note_002", "rejected", 422),
        receipt("patch_002", "compensation_conflict"),
      ]),
    ).toEqual([]);
  });
});
