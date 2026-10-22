import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlanReview } from "../src/components/PlanReview";
import { fixtureBundles } from "../src/fixtures";
import { formatMoney, sumMoney } from "../src/format";
import { evidenceFor, groupByCase, requiredRoles } from "../src/plan";

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("formatMoney", () => {
  it.each([
    [4210, "$42.10 CAD"],
    [12500, "$125.00 CAD"],
    [5, "$0.05 CAD"],
    [0, "$0.00 CAD"],
    [123456789, "$1,234,567.89 CAD"],
  ])("formats %i minor units exactly", (amountMinor, text) => {
    expect(formatMoney({ amountMinor, currency: "cad" })).toBe(text);
  });

  it("sums per currency without floats", () => {
    expect(
      sumMoney([
        { amountMinor: 4210, currency: "cad" },
        { amountMinor: 12500, currency: "cad" },
      ]),
    ).toEqual([{ amountMinor: 16710, currency: "cad" }]);
  });
});

describe("fixture bundles", () => {
  it("loads all four shared bundles in demo order", () => {
    expect(fixtureBundles.map((b) => b.bundle.id)).toEqual([
      "happy-path",
      "phantom",
      "teammate-conflict",
      "unknown-outcome",
    ]);
  });

  it.each(fixtureBundles.map((b) => [b.bundle.id, b] as const))("%s renders", (_id, b) => {
    const { manifest } = b.bundle;
    const html = renderToStaticMarkup(
      <PlanReview manifest={manifest} planHash={b.planHash} evidence={b.bundle.evidence} />,
    );

    expect(html).toContain(`title="${b.planHash}"`);
    expect(html).toContain("Fixture");
    expect(count(html, 'data-testid="case-card"')).toBe(groupByCase(manifest).length);
    expect(count(html, 'data-testid="action-row"')).toBe(manifest.actions.length);
    for (const a of manifest.actions) expect(html).toContain(`data-action-id="${a.id}"`);
  });
});

describe("happy-path review", () => {
  const { manifest } = fixtureBundles[0]?.bundle ?? expect.unreachable();
  const html = renderToStaticMarkup(
    <PlanReview manifest={manifest} planHash={"a".repeat(64)} evidence="fixture" />,
  );

  it("groups actions by customer, read from the case's evidence", () => {
    expect(groupByCase(manifest).map((c) => [c.caseId, c.customerId, c.actions.length])).toEqual([
      ["case_001", "cus_fixture_001", 3],
      ["case_002", "cus_fixture_002", 3],
    ]);
  });

  it("shows money, labels and who must sign", () => {
    expect(html).toContain("$42.10 CAD");
    expect(html).toContain("$125.00 CAD");
    expect(html).toContain("$167.10 CAD"); // plan total
    expect(html).toContain("Irreversible");
    expect(html).toContain("Reversible if unchanged");
    expect(html).toContain("No atomic guard");
    expect(html).toContain("priority: normal → high");
    expect(html).toContain("result of refund_001 (refund.id)");
    expect(requiredRoles(manifest)).toEqual(["finance_lead", "support_lead"]);
  });

  it("finds each action's evidence and flags anything cited but missing", () => {
    const refund = manifest.actions.find((a) => a.id === "refund_001") ?? expect.unreachable();
    const ev = evidenceFor(manifest, refund);
    expect(ev.observations.map((o) => o.id)).toEqual(["obs_charge_001"]);
    expect(ev.queries.map((q) => q.id)).toEqual(["q_charges_001"]);
    expect(ev.missing).toEqual([]);

    const dangling = { ...refund, evidence: ["obs_nowhere"] };
    expect(evidenceFor(manifest, dangling).missing).toEqual(["obs_nowhere"]);
  });
});
