import { readFileSync } from "node:fs";
import { Currency } from "@rehearsal/contracts";
import { describe, expect, it } from "vitest";
import { type BillingPolicyV1, evaluateBillingPolicy } from "../src/policy";
import { manifest, refund } from "./fixture";

/** Decision 0005: the policy and the seeded incident agree on CAD. These tests keep it that way. */
const scenario = (file: string) =>
  JSON.parse(readFileSync(new URL(`../../../scenarios/billing/${file}`, import.meta.url), "utf8"));
const policy: BillingPolicyV1 = scenario("policy.v1.json");
const incident: { cases: { key: string; kind: string; currency: string; amountMinor: number }[] } =
  scenario("incident.v1.json");

describe("policy v1 and the seeded incident (decision 0005)", () => {
  it("is CAD, a currency the contracts accept", () => {
    expect(policy).toEqual({
      id: "billing-remedy",
      version: 1,
      currency: "cad",
      financeThresholdMinor: 10_000,
    });
    expect(Currency.safeParse(policy.currency).success).toBe(true);
  });

  it("seeds every case in the policy's currency except the one currency control", () => {
    const off = incident.cases.filter((c) => c.currency !== policy.currency);
    expect(off.map((c) => c.kind)).toEqual(["control_other_currency"]);
  });

  it("puts duplicates on both sides of the finance threshold", () => {
    const amounts = incident.cases.filter((c) => c.kind === "duplicate").map((c) => c.amountMinor);
    expect(amounts.some((a) => a >= policy.financeThresholdMinor)).toBe(true);
    expect(amounts.some((a) => a < policy.financeThresholdMinor)).toBe(true);
  });

  it("holds a refund in any other currency (R1), even though contracts already refuse one", () => {
    const usd = {
      ...refund,
      args: { ...refund.args, amount: { amountMinor: 7_300, currency: "usd" } },
    } as unknown as typeof refund;
    expect(evaluateBillingPolicy(manifest([usd]), policy).violations).toEqual([
      { rule: "R1.currency", actionId: refund.id, detail: "refund in usd, policy allows cad" },
    ]);
  });

  it("needs nothing extra below the threshold", () => {
    const small = {
      ...refund,
      args: { ...refund.args, amount: { amountMinor: 9_999, currency: "cad" } },
    } as typeof refund;
    expect(evaluateBillingPolicy(manifest([small]), policy).violations).toEqual([]);
  });
});
