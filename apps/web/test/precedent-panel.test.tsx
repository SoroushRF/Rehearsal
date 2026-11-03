import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  SimilarPrecedents,
  SimilarResponse,
  type SimilarState,
} from "../src/components/PrecedentPanel";

const words = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replace(/\s+/g, " ");
const render = (state: SimilarState) =>
  renderToStaticMarkup(<SimilarPrecedents state={state} appliesTo="billing.duplicate_charge" />);

const found: SimilarResponse = {
  status: "ok",
  similar: [
    {
      id: "duplicate-charge-refund",
      version: 2,
      appliesTo: "billing.duplicate_charge",
      statement: "A duplicate charge within 30 days is refunded in full.",
      digest: "d".repeat(64),
      sameId: false,
    },
    {
      id: "small-duplicate",
      version: 1,
      appliesTo: "billing.duplicate_charge",
      statement: "A duplicate charge under 10.00 CAD is refunded without review.",
      digest: "e".repeat(64),
      sameId: true,
    },
  ],
};

describe("similar active precedents on the promote panel (T2.32)", () => {
  it("lists each similar active precedent with its version and statement", () => {
    const html = render(found);
    expect(html).toContain('data-state="ok"');
    const text = words(html);
    expect(text).toContain("Similar active precedents in Billing duplicate charge");
    expect(text).toContain("duplicate-charge-refund v2");
    expect(text).toContain("A duplicate charge within 30 days is refunded in full.");
    expect(text).toContain("small-duplicate v1");
    expect(text).toContain("(an earlier version of this precedent)");
    expect(text).toContain("Promoting doesn't change or withdraw these.");
    expect(html.match(/data-testid="similar-precedent"/g)).toHaveLength(2);
    // Only the second is an earlier version of the one being promoted.
    expect(text.match(/earlier version/g)).toHaveLength(1);
  });

  it("says when nothing similar is active in the area", () => {
    const text = words(render({ status: "ok", similar: [] }));
    expect(text).toContain("No similar active precedent in Billing duplicate charge.");
  });

  it("says memory is off, and that recall failed, without blocking anything", () => {
    expect(words(render({ status: "off", similar: [] }))).toContain(
      "Agent Memory is off, so similar precedents can't be checked.",
    );
    const failures: SimilarState[] = [{ status: "unavailable", similar: [] }, { kind: "failed" }];
    for (const state of failures) {
      expect(words(render(state))).toContain(
        "Couldn't check for similar precedents just now. You can still promote.",
      );
    }
    expect(words(render({ kind: "loading" }))).toContain("Checking for similar active precedents…");
  });

  it("parses only the shape the API answers with", () => {
    expect(SimilarResponse.safeParse(found).success).toBe(true);
    expect(SimilarResponse.safeParse({ status: "maybe", similar: [] }).success).toBe(false);
    expect(SimilarResponse.safeParse({ status: "ok" }).success).toBe(false);
  });
});
