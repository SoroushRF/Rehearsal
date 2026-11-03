import { describe, expect, it } from "vitest";
import { PlanManifest, PrecedentRecallDiagnostics, RECALL_DIAGNOSTICS_LIMITS } from "../src";

const sample = {
  recalled: true,
  areas: [
    {
      area: "billing.duplicate_charge",
      query: "billing.duplicate_charge",
      traceId: "tr_1",
      hits: [{ id: "dup-refund", version: 2, factIds: ["f1", "f2", "f3"], hitIds: ["h1"] }],
      dropped: [
        { id: "old-rule", reason: "registry has version 3", stage: "registry" },
        { id: "gone", reason: "withdrawn at v1", stage: "recall" },
      ],
    },
    {
      area: "billing.refund_window",
      query: "billing.refund_window",
      traceId: null,
      hits: [],
      dropped: [],
    },
  ],
};

describe("recall diagnostics", () => {
  it("parses found, dropped and empty recalls, and a plan that never recalled", () => {
    expect(PrecedentRecallDiagnostics.parse(sample)).toEqual(sample);
    expect(PrecedentRecallDiagnostics.safeParse({ recalled: false, areas: [] }).success).toBe(true);
  });

  it("refuses unknown keys, unknown stages and oversize input", () => {
    const area = sample.areas[0];
    const ok = (areas: unknown[]) =>
      PrecedentRecallDiagnostics.safeParse({ recalled: true, areas }).success;
    expect(PrecedentRecallDiagnostics.safeParse({ ...sample, approve: true }).success).toBe(false);
    expect(ok([{ ...area, dropped: [{ id: "x", reason: "r", stage: "model" }] }])).toBe(false);
    const reason = "x".repeat(RECALL_DIAGNOSTICS_LIMITS.reason + 1);
    expect(ok([{ ...area, dropped: [{ id: "x", reason, stage: "recall" }] }])).toBe(false);
    expect(ok([{ ...area, query: "q".repeat(RECALL_DIAGNOSTICS_LIMITS.text + 1) }])).toBe(false);
    expect(ok(Array(RECALL_DIAGNOSTICS_LIMITS.areas + 1).fill(area))).toBe(false);
    expect(ok(Array(RECALL_DIAGNOSTICS_LIMITS.areas).fill(area))).toBe(true);
  });

  it("is not part of the plan manifest, so it can't change the plan hash", () => {
    expect(Object.keys(PlanManifest.shape)).not.toContain("recallDiagnostics");
  });
});
