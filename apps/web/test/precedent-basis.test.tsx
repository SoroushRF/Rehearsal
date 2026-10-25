import type { PrecedentBasis } from "@rehearsal/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PrecedentBasisCard } from "../src/components/PrecedentBasisCard";
import { explainPrecedentHold, PrecedentCheck, type PrecedentHold } from "../src/precedent-holds";

const basis: PrecedentBasis = {
  citations: [
    {
      id: "duplicate-charge-refund",
      version: 2,
      digest: "d".repeat(64),
      appliesTo: "billing.duplicate_charge",
      factIds: ["fact_1", "fact_2"],
      traceId: "trace_abc",
    },
  ],
  epochs: { "billing.duplicate_charge": 3 },
};

const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const render = (check: Parameters<typeof PrecedentBasisCard>[0]["check"]) =>
  renderToStaticMarkup(<PrecedentBasisCard basis={basis} check={check} />);

describe("precedent basis card (T2.17)", () => {
  it("shows each cited version with its trace, fact count and fact IDs", () => {
    const text = words(render({ ok: true }));
    expect(text).toContain("duplicate-charge-refund v2");
    expect(text).toContain("billing.duplicate_charge");
    expect(text).toContain("trace_abc");
    expect(text).toContain("2 stored facts");
    expect(text).toContain("fact_1 fact_2");
    expect(text).toContain("All still in force");
  });

  it("says it wasn't checked, rather than implying the citations hold, when there is no verdict", () => {
    const html = render(null);
    expect(words(html)).toContain("Not checked");
    expect(words(html)).not.toContain("still in force");
    expect(html).toContain('data-held="false"');
  });

  it("marks the cited version held, and explains why, when it was replaced", () => {
    const holds: PrecedentHold[] = [
      { id: "duplicate-charge-refund", reason: "superseded", citedVersion: 2, activeVersion: 3 },
      {
        appliesTo: "billing.duplicate_charge",
        reason: "epoch_changed",
        plannedEpoch: 3,
        currentEpoch: 4,
      },
    ];
    const html = render({ ok: false, holds });
    const text = words(html);
    expect(html).toContain('data-held="true"');
    expect(text).toContain("Changed since planning");
    expect(text).toContain("duplicate-charge-refund v2 was replaced by v3");
    expect(text).toContain("precedents the planner may never have seen");
    expect(text).toContain("Approval is refused until the plan is revised");
  });

  it("handles a plan that consulted precedents and cited none", () => {
    const html = renderToStaticMarkup(
      <PrecedentBasisCard
        basis={{ citations: [], epochs: { "billing.late_fee": 0 } }}
        check={{ ok: true }}
      />,
    );
    expect(words(html)).toContain("cited none");
    expect(html).not.toContain('data-testid="citation"');
  });

  it("has a sentence for every hold, with the versions named", () => {
    const base = { id: "p", citedVersion: 1 };
    expect(explainPrecedentHold({ ...base, reason: "withdrawn", activeVersion: null })).toContain(
      "withdrawn",
    );
    expect(explainPrecedentHold({ ...base, reason: "not_active", activeVersion: 0 })).toContain(
      "v0",
    );
    expect(
      explainPrecedentHold({ ...base, reason: "content_changed", activeVersion: 1 }),
    ).toContain("no longer says");
  });

  it("reads what the API sends, and nothing else", () => {
    expect(PrecedentCheck.safeParse({ ok: true }).success).toBe(true);
    expect(
      PrecedentCheck.safeParse({
        ok: false,
        holds: [{ id: "p", reason: "withdrawn", citedVersion: 1, activeVersion: null }],
      }).success,
    ).toBe(true);
    expect(PrecedentCheck.safeParse({ ok: false }).success).toBe(false);
    expect(PrecedentCheck.safeParse({ ok: false, holds: [{ reason: "mystery" }] }).success).toBe(
      false,
    );
  });
});
