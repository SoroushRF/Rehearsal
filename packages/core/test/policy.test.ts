import { readFileSync } from "node:fs";
import { Currency } from "@rehearsal/contracts";
import { describe, expect, it } from "vitest";
import { type BillingPolicyV1, type BillingPolicyV2, evaluateBillingPolicy } from "../src/policy";
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

/** Decision 0010: v2 adds the invoice credit as a second remedy for one obligation. */
describe("policy v2: refund or invoice credit (T2.18)", () => {
  const v2: BillingPolicyV2 = scenario("policy.v2.json");
  const credit = (id: string, amountMinor: number, over: Record<string, unknown> = {}) => ({
    id,
    caseId: refund.caseId,
    obligationId: refund.obligationId,
    requiredRole: "support_lead" as const,
    dependsOn: [],
    kind: "stripe.customer.balanceCredit" as const,
    args: { amount: { amountMinor, currency: "cad" as const } },
    ...over,
  });
  const rules = (r: { violations: { rule: string }[] }) => r.violations.map((v) => v.rule);

  it("is a new version of the same policy, not an edit of v1", () => {
    expect(v2).toEqual({
      id: "billing-remedy",
      version: 2,
      currency: "cad",
      financeThresholdMinor: policy.financeThresholdMinor,
      creditMaxMinor: 10_000,
    });
  });

  it("accepts a small credit, or a refund, for an obligation", () => {
    expect(evaluateBillingPolicy({ actions: [credit("credit_1", 4_210)] }, v2).violations).toEqual(
      [],
    );
    expect(evaluateBillingPolicy(manifest([refund]), v2).violations).toEqual([]);
  });

  it("holds a credit from policy v1, which only knows refunds", () => {
    const result = evaluateBillingPolicy({ actions: [credit("credit_1", 4_210)] }, policy);
    expect(rules(result)).toEqual(["R4.remedy_not_allowed"]);
  });

  it("makes a large obligation a refund: a credit at the limit is held", () => {
    const below = evaluateBillingPolicy({ actions: [credit("c", 9_999)] }, v2);
    expect(below.violations).toEqual([]);
    const at = evaluateBillingPolicy(
      { actions: [credit("c", 10_000, { requiredRole: "finance_lead" })] },
      v2,
    );
    expect(rules(at)).toEqual(["R4.credit_over_limit"]);
  });

  it("allows one remedy per obligation across a refund and a credit", () => {
    const both = evaluateBillingPolicy({ actions: [refund, credit("credit_1", 4_210)] }, v2);
    expect(both.violations).toEqual([
      {
        rule: "R2.single_remedy",
        actionId: "credit_1",
        detail: `obligation ${refund.obligationId} already remedied by ${refund.id}`,
      },
    ]);
    // Different obligations don't collide.
    const apart = evaluateBillingPolicy(
      { actions: [refund, credit("credit_2", 1_000, { obligationId: "obl_other" })] },
      v2,
    );
    expect(apart.violations).toEqual([]);
  });

  it("holds the same currency and finance rules for a credit as for a refund", () => {
    const usd = credit("credit_usd", 1_000, {
      args: { amount: { amountMinor: 1_000, currency: "usd" } },
    });
    expect(rules(evaluateBillingPolicy({ actions: [usd] } as never, v2))).toEqual(["R1.currency"]);
    const lowCreditMax = { ...v2, creditMaxMinor: 50_000 };
    const big = credit("credit_big", 20_000);
    expect(rules(evaluateBillingPolicy({ actions: [big] }, lowCreditMax))).toEqual([
      "R3.finance_threshold",
    ]);
  });

  it("blocks a second remedy once one is known to have completed, whichever kind", () => {
    const completedRemedies = new Map([[refund.obligationId, { actionId: "refund_earlier" }]]);
    for (const step of [refund, credit("credit_1", 1_000)]) {
      const result = evaluateBillingPolicy({ actions: [step] }, v2, { completedRemedies });
      expect(result.violations).toEqual([
        {
          rule: "R5.remedy_already_completed",
          actionId: step.id,
          detail: `obligation ${refund.obligationId} was already remedied by refund_earlier`,
        },
      ]);
    }
    // v1 knows the rule too: a completed refund blocks a second refund.
    expect(rules(evaluateBillingPolicy(manifest([refund]), policy, { completedRemedies }))).toEqual(
      ["R5.remedy_already_completed"],
    );
  });

  it("leaves other obligations alone when one is already remedied", () => {
    const completedRemedies = new Map([["obl_other", { actionId: "refund_earlier" }]]);
    expect(evaluateBillingPolicy(manifest([refund]), v2, { completedRemedies }).violations).toEqual(
      [],
    );
  });
});
