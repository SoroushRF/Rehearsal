import type { ExecutionRehearsalReportView } from "@rehearsal/contracts";
import { ExecutionRehearsalReportView as View } from "@rehearsal/contracts";
import { rehearsalReportFixture } from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import { headline, observedLabel, staleReasons, tally } from "../src/rehearsal-report";

const passed = rehearsalReportFixture("passed");
const current = {
  planId: passed.plan.planId,
  revision: passed.plan.revision,
  planHash: passed.plan.planHash,
};
const view = (
  report = passed,
  stale: ExecutionRehearsalReportView["stale"] = [],
): ExecutionRehearsalReportView => View.parse({ report, stale });

describe("staleReasons", () => {
  it("is empty for the revision and hash on screen", () => {
    expect(staleReasons(view(), current)).toEqual([]);
  });

  it("keeps what the server found and adds what the page can see", () => {
    expect(staleReasons(view(passed, ["policy_changed"]), current)).toEqual(["policy_changed"]);
    expect(staleReasons(view(), { ...current, revision: current.revision + 1 })).toEqual([
      "newer_revision",
    ]);
    expect(staleReasons(view(), { ...current, planHash: "f".repeat(64) })).toEqual([
      "different_hash",
    ]);
  });

  it("does not repeat a reason both sides found", () => {
    const next = { ...current, revision: current.revision + 1 };
    expect(staleReasons(view(passed, ["newer_revision"]), next)).toEqual(["newer_revision"]);
  });
});

describe("headline", () => {
  it("never calls a pass safe or an unknown fine", () => {
    const pass = headline(passed, false);
    expect(pass.tone).toBe("good");
    expect(`${pass.title} ${pass.body}`).not.toMatch(/\bsafe\b/i);
    expect(headline(rehearsalReportFixture("unknown"), false).tone).toBe("warn");
    expect(headline(rehearsalReportFixture("failed"), false).tone).toBe("danger");
  });

  it("is not green once the report is stale", () => {
    expect(headline(passed, true).tone).toBe("warn");
  });

  it("says a failed or cancelled run did not finish, whatever the verdict says", () => {
    expect(headline({ ...passed, state: "failed" }, false).title).toMatch(/failed/);
    expect(headline({ ...passed, state: "cancelled" }, false).title).toMatch(/cancelled/);
  });

  // T2.28: a send can land and its receipt fail to save, so a missing result proves nothing.
  it("never says a step with no recorded result didn't run", () => {
    const unknown = rehearsalReportFixture("unknown");
    for (const report of [
      { ...unknown, state: "failed" as const },
      { ...unknown, state: "cancelled" as const },
      unknown,
    ]) {
      const { title, body } = headline(report, false);
      expect(`${title} ${body}`).not.toMatch(/never ran|not tried|didn't run/i);
    }
  });
});

describe("tally and observed", () => {
  it("counts each verification, and a step with no result has none recorded", () => {
    const unknown = rehearsalReportFixture("unknown");
    const t = tally(unknown.steps);
    expect(t.unverified).toBeGreaterThan(0);
    expect(t.matched + t.mismatched + t.unverified).toBe(unknown.steps.length);
    const first = unknown.steps[0];
    expect(first && observedLabel({ ...first, result: null })).toBe("No result recorded");
  });
});
