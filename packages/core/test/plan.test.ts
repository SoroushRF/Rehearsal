import { describe, expect, it } from "vitest";
import { dependentsClosure, excludeActions, topoOrder, validateGraph } from "../src/dag";
import { planHash } from "../src/hash";
import { evaluateBillingPolicy } from "../src/policy";
import { manifest, note, patch, refund } from "./fixture";

describe("planHash", () => {
  it("ignores key order and unknown keys, but not content", () => {
    const m = manifest();
    const reordered = {
      ...Object.fromEntries(Object.entries(m).reverse()),
      uiOnly: { expanded: true },
    };
    expect(planHash(reordered)).toBe(planHash(m));

    const changed = manifest([
      {
        ...refund,
        args: { ...refund.args, amount: { amountMinor: 4211, currency: "cad" } },
      } as typeof refund,
      patch,
      note,
    ]);
    expect(planHash(changed)).not.toBe(planHash(m));
  });

  it("is sensitive to action order", () => {
    expect(planHash(manifest([patch, refund, note]))).not.toBe(planHash(manifest()));
  });
});

describe("dependency graph", () => {
  it("validates and orders", () => {
    expect(validateGraph(manifest().actions)).toEqual([]);
    // Earliest ready action in manifest order wins: note becomes ready right after refund.
    expect(topoOrder([note, refund, patch]).map((a) => a.id)).toEqual([
      "refund_1",
      "note_1",
      "patch_1",
    ]);
  });

  it("flags a result ref to a step that is not a dependency", () => {
    const issues = validateGraph([refund, { ...note, dependsOn: [] }]);
    expect(issues.map((i) => i.problem)).toContain("unbound_result_ref");
  });

  it("detects cycles", () => {
    const issues = validateGraph([{ ...refund, dependsOn: ["note_1"] }, note]);
    expect(issues.map((i) => i.problem)).toContain("cycle");
  });

  it("excluding a refund drops its dependent note in a new revision", () => {
    const m = manifest();
    expect([...dependentsClosure(m.actions, ["refund_1"])].sort()).toEqual(["note_1", "refund_1"]);

    const next = excludeActions(m, ["refund_1"]);
    expect(next.revision).toBe(2);
    expect(next.parentRevision).toBe(1);
    expect(next.actions.map((a) => a.id)).toEqual(["patch_1"]);
    expect(next.excluded).toEqual([
      { actionId: "refund_1", reason: "reviewer" },
      { actionId: "note_1", reason: "dependency" },
    ]);
    expect(m.actions).toHaveLength(3); // original untouched
    expect(planHash(next)).not.toBe(planHash(m));
  });
});

describe("billing policy v1", () => {
  const policy = {
    id: "billing-remedy",
    version: 1,
    currency: "cad",
    financeThresholdMinor: 10_000,
  } as const;

  it("requires finance_lead at or above the threshold", () => {
    const big = {
      ...refund,
      args: { ...refund.args, amount: { amountMinor: 10_000, currency: "cad" } },
    } as typeof refund;
    expect(evaluateBillingPolicy(manifest([big]), policy).violations.map((v) => v.rule)).toEqual([
      "R3.finance_threshold",
    ]);
    const approved = evaluateBillingPolicy(
      manifest([{ ...big, requiredRole: "finance_lead" }]),
      policy,
    );
    expect(approved.violations).toEqual([]);
    expect([...approved.requiredRoles]).toEqual(["finance_lead"]);
  });

  it("rejects a second refund for the same obligation", () => {
    const again = { ...refund, id: "refund_2" };
    expect(
      evaluateBillingPolicy(manifest([refund, again]), policy).violations.map((v) => v.rule),
    ).toEqual(["R2.single_remedy"]);
  });
});
