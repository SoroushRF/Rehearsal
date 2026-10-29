import type { Action, Receipt } from "@rehearsal/contracts";
import { billingManifest } from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import { planHash, repairScope } from "../src";

const manifest = billingManifest("plan_repair_scope");
const hash = planHash(manifest);
const receipt = (
  actionId: string,
  outcome: Receipt["outcome"],
  holdReason: Receipt["holdReason"] = null,
): Receipt => ({
  id: `rcpt_${actionId}_${outcome}`,
  actionId,
  planHash: hash,
  approvalId: "grant_1",
  outcome,
  providerRef: null,
  observedEffect: {},
  protection: "native_guard_with_documented_limits",
  holdReason,
  limitations: [],
  recordedAt: "2026-10-21T12:00:00.000Z",
});
const phantomHold = {
  kind: "query_membership_changed" as const,
  queryObservationId: "q_charges_001",
  added: ["ch_new"],
  removed: [],
};
/** The phantom run: case 001's refund held and its note skipped, the rest confirmed. */
const phantomRun = () => [
  receipt("refund_001", "held", phantomHold),
  receipt("patch_001", "confirmed"),
  receipt("note_001", "skipped_dependency", {
    kind: "predecessor_not_confirmed",
    stepId: "refund_001",
  }),
  receipt("refund_002", "confirmed"),
  receipt("patch_002", "confirmed"),
  receipt("note_002", "confirmed"),
];

describe("repair scope (T1.37)", () => {
  it("keeps what was confirmed, replans the held case and refreshes what the hold found", () => {
    expect(repairScope(manifest, phantomRun(), [])).toEqual({
      ok: true,
      kept: ["patch_001", "refund_002", "patch_002", "note_002"],
      openCases: ["case_001"],
      replanned: ["refund_001", "note_001"],
      refresh: [{ vendor: "stripe", kind: "charge", id: "ch_new" }],
    });
  });

  it("reads the latest receipt of each step, so a resumed run's confirmation counts", () => {
    const scope = repairScope(
      manifest,
      [...phantomRun(), receipt("refund_001", "confirmed"), receipt("note_001", "confirmed")],
      [],
    );
    expect(scope).toEqual({ ok: false, reason: "every step was confirmed; nothing to repair" });
  });

  it("replans steps that never ran, such as after a cancel", () => {
    const scope = repairScope(manifest, [receipt("refund_002", "confirmed")], []);
    expect(scope).toMatchObject({ ok: true, openCases: ["case_001", "case_002"], refresh: [] });
  });

  it("never keeps a run summary: the repair's own run reports on itself", () => {
    const summary: Action = {
      id: "run_summary",
      kind: "slack.message.postSummary",
      caseId: "run",
      obligationId: "run_summary",
      dependsOn: manifest.actions.map((a) => a.id),
      requiredRole: "support_lead",
      evidence: [],
      queryEvidence: [],
      compensation: "irreversible",
      protection: "no_atomic_guard",
      rationale: "x",
      args: {
        channelId: "C1",
        template: { id: "run-summary", version: 1 },
        bindings: { incidentId: "INC" },
      },
    } as Action;
    const withSummary = { ...manifest, actions: [...manifest.actions, summary] };
    const scope = repairScope(
      withSummary,
      [...phantomRun(), receipt("run_summary", "confirmed")],
      [],
    );
    expect(scope).toMatchObject({ ok: true, replanned: ["refund_001", "note_001", "run_summary"] });
    if (scope.ok) expect(scope.kept).not.toContain("run_summary");
  });

  it.each([
    ["an unknown outcome", [receipt("refund_001", "unknown_outcome")], /ended unknown_outcome/],
    ["a provider refusal", [receipt("refund_001", "rejected")], /ended rejected/],
    ["an undone step", [receipt("patch_001", "compensated")], /ended compensated/],
    [
      "a changed row",
      [
        receipt("patch_001", "held", {
          kind: "row_changed",
          observationId: "o",
          fields: ["priority"],
        }),
      ],
      /held \(row_changed\)/,
    ],
    [
      "an unresolved send",
      [receipt("refund_001", "held", { kind: "unresolved_outcome", attemptId: "a" })],
      /held \(unresolved_outcome\)/,
    ],
    [
      "a record that left the query",
      [receipt("refund_001", "held", { ...phantomHold, added: [], removed: ["ch_gone"] })],
      /ch_gone left the query/,
    ],
  ])("refuses %s", (_, receipts, reason) => {
    const scope = repairScope(manifest, receipts, []);
    expect(scope.ok).toBe(false);
    if (!scope.ok) expect(scope.reason).toMatch(reason);
  });

  it("refuses while a send is in flight: that is reconciled by resuming the run", () => {
    expect(repairScope(manifest, phantomRun(), ["refund_001"])).toEqual({
      ok: false,
      reason: "refund_001 has a send in flight; resume the run first",
    });
  });
});
