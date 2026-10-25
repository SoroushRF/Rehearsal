import type { Action } from "@rehearsal/contracts";
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

  it("hashes a plan without a precedent basis exactly as before the field existed", () => {
    // Pinned before `precedentBasis` was added: approvals of existing plans must stay valid.
    const golden = "bb07408c6d8e0008a97fa97065c8b670b54d06f2f7a6e4b3fcd6044811b719aa";
    expect(planHash(manifest())).toBe(golden);
    expect(planHash({ ...manifest(), precedentBasis: undefined })).toBe(golden);
  });

  it("covers the precedent basis", () => {
    const citation = {
      id: "dup-charge-refund",
      version: 2,
      digest: "c".repeat(64),
      appliesTo: "billing.duplicate_charge",
      factIds: ["fact_1"],
      traceId: "trace_1",
    };
    const basis = { citations: [citation], epochs: { "billing.duplicate_charge": 3 } };
    const cited = planHash({ ...manifest(), precedentBasis: basis });
    expect(cited).not.toBe(planHash(manifest()));
    expect(
      planHash({
        ...manifest(),
        precedentBasis: { ...basis, epochs: { "billing.duplicate_charge": 4 } },
      }),
    ).not.toBe(cited);
    expect(
      planHash({
        ...manifest(),
        precedentBasis: { ...basis, citations: [{ ...citation, version: 3 }] },
      }),
    ).not.toBe(cited);
    // A citation without its area's epoch can't be approved at all.
    expect(() => planHash({ ...manifest(), precedentBasis: { ...basis, epochs: {} } })).toThrow();
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

describe("run summary in the graph (T1.7)", () => {
  const summary = {
    ...patch,
    id: "summary",
    caseId: "run",
    obligationId: "run_summary",
    dependsOn: ["refund_1", "patch_1", "note_1"],
    evidence: [],
    queryEvidence: [],
    compensation: "irreversible",
    protection: "no_atomic_guard",
    kind: "slack.message.postSummary",
    args: {
      channelId: "chan-general",
      template: { id: "run-summary", version: 1 },
      bindings: {
        incidentId: "inc_1",
        refunded: { $count: "outcomes", stepIds: ["refund_1"], outcomes: ["confirmed"] },
        held: { $count: "outcomes", stepIds: ["patch_1", "note_1"], outcomes: ["held"] },
      },
    },
  } as const satisfies Action;

  it("lets no step depend on a summary, except another summary", () => {
    const issues = validateGraph([
      refund,
      patch,
      note,
      summary,
      { ...patch, id: "late", dependsOn: ["summary"] },
    ]);
    expect(issues).toEqual([
      expect.objectContaining({ actionId: "late", problem: "depends_on_summary" }),
    ]);
    expect(
      validateGraph([
        refund,
        patch,
        note,
        summary,
        { ...summary, id: "again", dependsOn: ["summary"] },
      ]),
    ).toEqual([]);
  });

  it("unchecking a counted step takes it out of the counts, not the summary", () => {
    const next = excludeActions(manifest([refund, patch, note, summary]), ["patch_1"]);
    const kept = next.actions.find((a) => a.id === "summary");
    expect(kept?.dependsOn).toEqual(["refund_1", "note_1"]);
    expect(kept?.kind === "slack.message.postSummary" && kept.args.bindings.held).toEqual({
      $count: "outcomes",
      stepIds: ["note_1"],
      outcomes: ["held"],
    });
    expect(next.excluded).toEqual([{ actionId: "patch_1", reason: "reviewer" }]);
  });

  it("drops the summary once a count has nothing left to count", () => {
    const next = excludeActions(manifest([refund, patch, note, summary]), ["refund_1"]);
    expect(next.actions.map((a) => a.id)).toEqual(["patch_1"]);
    expect(next.excluded).toEqual([
      { actionId: "refund_1", reason: "reviewer" },
      { actionId: "note_1", reason: "dependency" },
      { actionId: "summary", reason: "dependency" },
    ]);
  });

  it("unchecking the summary itself drops only the summary", () => {
    const next = excludeActions(manifest([refund, patch, note, summary]), ["summary"]);
    expect(next.actions.map((a) => a.id)).toEqual(["refund_1", "patch_1", "note_1"]);
  });
});
