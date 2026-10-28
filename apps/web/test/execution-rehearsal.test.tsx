import { ExecutionRehearsalRequest } from "@rehearsal/contracts";
import { rehearsalJobFixture } from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import { RefusedError } from "../src/api";
import {
  activeFor,
  CREATE_REVISION_FIRST,
  type ExecutionRehearsalSummary,
  explainRehearsalRefusal,
  isTerminal,
  isUnavailable,
  relationTo,
  requestFor,
  SCENARIOS,
  startBlocked,
} from "../src/execution-rehearsal";

const job = rehearsalJobFixture();
const current = {
  planId: job.plan.planId,
  revision: job.plan.revision,
  planHash: job.plan.planHash,
};
const summary = (over: Partial<ExecutionRehearsalSummary> = {}): ExecutionRehearsalSummary => ({
  rehearsalId: job.rehearsalId,
  plan: job.plan,
  scenario: job.scenario,
  state: "running",
  detail: null,
  requestedBy: "user_support",
  requestedAt: "2026-10-25T12:00:00.000Z",
  updatedAt: "2026-10-25T12:00:00.000Z",
  ...over,
});

describe("requestFor", () => {
  it("sends only references the contract accepts, for every scenario on offer", () => {
    for (const s of SCENARIOS) {
      expect(ExecutionRehearsalRequest.safeParse(requestFor(current, s.id)).success).toBe(true);
    }
  });

  it("names the revision and hash on screen", () => {
    expect(requestFor(current, "clean")).toMatchObject({
      revision: current.revision,
      planHash: current.planHash,
    });
  });
});

describe("relationTo", () => {
  it("ties a rehearsal to the revision and hash it ran on", () => {
    expect(relationTo(summary(), current)).toBe("current");
    expect(relationTo(summary(), { ...current, revision: current.revision + 1 })).toBe(
      "older_revision",
    );
    expect(relationTo(summary(), { ...current, planHash: "f".repeat(64) })).toBe("other_hash");
  });
});

describe("activeFor", () => {
  it("finds a job still going for this plan and scenario only", () => {
    expect(activeFor([summary()], current, "clean")).toBeDefined();
    expect(activeFor([summary()], current, "phantom_membership")).toBeUndefined();
    expect(activeFor([summary({ state: "failed" })], current, "clean")).toBeUndefined();
    expect(activeFor([summary()], { ...current, revision: 9 }, "clean")).toBeUndefined();
  });
});

describe("startBlocked", () => {
  const ended = [summary({ state: "failed" }), summary({ state: "cancelled" })];

  it("refuses every start while unchecked boxes have no revision, finished jobs included", () => {
    for (const id of ["clean", "phantom_membership"] as const) {
      expect(startBlocked(ended, current, id, true)).toBe(CREATE_REVISION_FIRST);
    }
    expect(startBlocked([], current, "clean", true)).toBe(CREATE_REVISION_FIRST);
  });

  it("refuses a scenario already going for this revision, and nothing else", () => {
    expect(startBlocked([summary()], current, "clean", false)).toMatch(/already running/);
    expect(startBlocked([summary()], current, "phantom_membership", false)).toBeNull();
    expect(startBlocked(ended, current, "clean", false)).toBeNull();
  });
});

describe("states and refusals", () => {
  it("treats finished, failed and cancelled as terminal", () => {
    expect(["completed", "failed", "cancelled"].every((s) => isTerminal(s as never))).toBe(true);
    expect(
      ["queued", "provisioning", "running", "verifying"].some((s) => isTerminal(s as never)),
    ).toBe(false);
  });

  it("reads a missing route as 'not available', not as an error", () => {
    expect(isUnavailable(new RefusedError(501, { error: "http_501" }))).toBe(true);
    expect(isUnavailable(new RefusedError(403, { error: "forbidden" }))).toBe(false);
  });

  it("explains refusals, and leaves unknown ones to the shared wording", () => {
    const stale = new RefusedError(409, { error: "stale_revision", latestRevision: 4 });
    expect(explainRehearsalRefusal(stale)).toContain("revision (4)");
    expect(explainRehearsalRefusal(new RefusedError(400, { error: "who_knows" }))).toBeNull();
    expect(explainRehearsalRefusal(new Error("x"))).toBeNull();
  });
});
