import { ExecutionRehearsalReport, type Receipt } from "@rehearsal/contracts";
import { VERIFIER_VERSION } from "@rehearsal/core";
import {
  FIXTURE_REHEARSAL_VERSIONS,
  happyPathBundle,
  rehearsalJobFixture,
} from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import { rehearsalReport } from "../src/rehearsal-runner";

const manifest = happyPathBundle().manifest;
const job = rehearsalJobFixture();
const when = {
  startedAt: "2026-10-21T11:00:00.000Z",
  finishedAt: "2026-10-21T11:10:00.000Z",
};

function receipt(actionId: string): Receipt {
  return {
    id: `rcpt_${actionId}`,
    actionId,
    planHash: job.plan.planHash,
    approvalId: "rehearsal",
    outcome: "confirmed",
    providerRef: null,
    observedEffect: { "refund.status": "succeeded", "refund.id": "re_green" },
    protection: "no_atomic_guard",
    holdReason: null,
    limitations: [],
    recordedAt: "2026-10-21T11:05:00.000Z",
  };
}

function report(
  verifications?: ReadonlyMap<
    string,
    { status: "matched" | "mismatched" | "unverified"; detail: string }
  >,
  receipts: Receipt[] = manifest.actions.map((action) => receipt(action.id)),
) {
  return rehearsalReport(job, manifest, receipts, {
    state: "completed",
    limitations: [],
    notFromEvidence: [],
    ...when,
    versions: { ...FIXTURE_REHEARSAL_VERSIONS, verifier: VERIFIER_VERSION },
    evidence: "fixture",
    verifications,
  });
}

describe("rehearsal report verification (T4.12)", () => {
  it("stays unknown until a verifier reads the tenant", () => {
    const built = report(undefined, []);
    expect(built.verdict).toBe("unknown");
    expect(built.limitations[0]).toContain("no independent verification");
    expect(built.steps.every((step) => step.verification.status === "unverified")).toBe(true);
    expect(ExecutionRehearsalReport.safeParse(built).success).toBe(true);
  });

  it("passes only when every step was read as expected", () => {
    const verifications = new Map(
      manifest.actions.map((action) => [
        action.id,
        { status: "matched" as const, detail: "one effect" },
      ]),
    );
    const built = report(verifications);
    expect(built.verdict).toBe("passed");
    expect(built.versions.verifier).toBe(VERIFIER_VERSION);
    expect(ExecutionRehearsalReport.safeParse(built).success).toBe(true);
  });

  it("fails when a green receipt disagrees with the verifier", () => {
    const verifications = new Map(
      manifest.actions.map((action) => [
        action.id,
        {
          status: (action.id === "refund_001" ? "mismatched" : "matched") as
            | "matched"
            | "mismatched",
          detail:
            action.id === "refund_001"
              ? "missing effect; the receipt says confirmed"
              : "one effect",
        },
      ]),
    );
    const built = report(verifications);
    expect(
      built.steps.find((step) => step.actionId === "refund_001")?.result?.observedEffect,
    ).toMatchObject({
      "refund.status": "succeeded",
    });
    expect(built.verdict).toBe("failed");
    expect(ExecutionRehearsalReport.safeParse(built).success).toBe(true);
  });

  it("does not verify a step with no recorded result", () => {
    const verifications = new Map(
      manifest.actions.map((action) => [
        action.id,
        { status: "matched" as const, detail: "one effect" },
      ]),
    );
    const built = report(verifications, []);
    expect(built.verdict).toBe("unknown");
    expect(built.steps[0]?.verification.detail).toContain("no result was recorded");
  });
});
