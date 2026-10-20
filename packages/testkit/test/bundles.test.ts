import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ReplayBundle } from "@rehearsal/contracts";
import { evaluateBillingPolicy, excludeActions, planHash, validateGraph } from "@rehearsal/core";
import { describe, expect, it } from "vitest";
import { allBundles, happyPathBundle } from "../src/bundles";

const policy = {
  id: "billing-remedy",
  version: 1,
  currency: "cad",
  financeThresholdMinor: 10_000,
} as const;
const casesDir = new URL("../../../scenarios/billing/cases/", import.meta.url);

describe.each(allBundles().map((b) => [b.id, b] as const))("bundle %s", (id, bundle) => {
  it("matches the contract", () => {
    expect(() => ReplayBundle.parse(bundle)).not.toThrow();
  });

  it("has a valid graph and passes policy", () => {
    expect(validateGraph(bundle.manifest.actions)).toEqual([]);
    expect(evaluateBillingPolicy(bundle.manifest, policy).violations).toEqual([]);
  });

  it("states an expected outcome for every action", () => {
    expect(bundle.expected.map((e) => e.actionId).sort()).toEqual(
      bundle.manifest.actions.map((a) => a.id).sort(),
    );
  });

  it("is in sync with the committed JSON (run `pnpm fixtures:write`)", () => {
    const file = fileURLToPath(new URL(`${id}.bundle.json`, casesDir));
    const committed = JSON.parse(readFileSync(file, "utf8"));
    expect(committed.bundle).toEqual(bundle);
    expect(committed.planHash).toBe(planHash(bundle.manifest));
  });
});

it("unchecking customer 001's refund drops its note but keeps everything else", () => {
  const m = happyPathBundle().manifest;
  const next = excludeActions(m, ["refund_001"]);
  expect(next.actions.map((a) => a.id)).toEqual([
    "patch_001",
    "refund_002",
    "patch_002",
    "note_002",
  ]);
});
