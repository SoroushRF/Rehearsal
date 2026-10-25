import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RehearsalScenarioId } from "@rehearsal/contracts";
import { CHALLENGE_CATALOG_VERSION, challengeCatalogDocument } from "@rehearsal/core";
import { describe, expect, it } from "vitest";
import { rehearsalChallengeFixtures, rehearsalReportFixture } from "../src";

const challengesFile = fileURLToPath(
  new URL("../../../scenarios/billing/challenges.v1.json", import.meta.url),
);

describe("rehearsal challenge fixtures (T4.11)", () => {
  it("binds every published scenario to the happy-path plan", () => {
    const fixtures = rehearsalChallengeFixtures();
    expect(fixtures.map((s) => s.id).sort()).toEqual([...RehearsalScenarioId.options].sort());
    const phantom = fixtures.find((s) => s.id === "phantom_membership");
    expect(phantom?.steps.find((s) => s.actionId === "refund_001")).toMatchObject({
      outcome: "held",
      holdKind: "query_membership_changed",
    });
    expect(phantom?.steps.find((s) => s.actionId === "note_001")?.outcome).toBe(
      "skipped_dependency",
    );
    expect(phantom?.steps.find((s) => s.actionId === "refund_002")?.outcome).toBe("confirmed");
    const ids = JSON.stringify(fixtures);
    expect(ids).not.toMatch(/ch_INC|cus_nec|9100002/);
    expect(ids).toMatch(/cus_fixture_001/);
  });

  it("matches the committed catalog (run `pnpm fixtures:write`)", () => {
    const committed = JSON.parse(readFileSync(challengesFile, "utf8"));
    expect(committed).toEqual(challengeCatalogDocument());
    expect(committed.evidence).toBe("fixture");
    expect(committed.catalogVersion).toBe(CHALLENGE_CATALOG_VERSION);
  });

  it("builds report fixtures from the catalog's expected outcomes", () => {
    const failed = rehearsalReportFixture("failed");
    expect(failed.scenario).toEqual({ id: "phantom_membership", version: 1 });
    expect(failed.steps.find((s) => s.actionId === "refund_001")).toMatchObject({
      expected: "held",
      result: { outcome: "confirmed" },
      verification: { status: "mismatched" },
    });
    expect(failed.steps.find((s) => s.actionId === "note_001")?.expected).toBe(
      "skipped_dependency",
    );
    const unknown = rehearsalReportFixture("unknown");
    expect(unknown.scenario.id).toBe("lost_response_restart");
    expect(unknown.steps.find((s) => s.actionId === "refund_001")).toMatchObject({
      expected: "confirmed",
      result: { outcome: "unknown_outcome" },
      verification: { status: "unverified" },
    });
    const passed = rehearsalReportFixture("passed");
    const clean = rehearsalChallengeFixtures().find((s) => s.id === "clean");
    expect(passed.challengesDigest).toBe(clean?.digest);
  });
});
