import {
  ApprovalGrant,
  ExecutionRehearsalJob,
  ExecutionRehearsalReport,
  ExecutionRehearsalReportView,
  ExecutionRehearsalRequest,
  Observation,
  PlanManifest,
  Receipt,
  RehearsalStepResult,
  type RehearsalVersions,
} from "@rehearsal/contracts";
import {
  planHash,
  REHEARSAL_REPORT_TTL_MS,
  rehearsalOperationKey,
  rehearsalStaleness,
  rehearsalTenant,
  snapshotDigest,
} from "@rehearsal/core";
import { describe, expect, it } from "vitest";
import {
  FIXTURE_REHEARSAL_ID,
  FIXTURE_REHEARSAL_VERSIONS,
  happyPathBundle,
  rehearsalJobFixture,
  rehearsalReportFixture,
  rehearsalRequestFixture,
} from "../src";

describe("execution rehearsal contracts (T1.21)", () => {
  it("parses the request, job and every report fixture", () => {
    expect(ExecutionRehearsalRequest.parse(rehearsalRequestFixture())).toBeTruthy();
    expect(ExecutionRehearsalJob.parse(rehearsalJobFixture())).toBeTruthy();
    for (const verdict of ["passed", "failed", "unknown"] as const) {
      expect(ExecutionRehearsalReport.parse(rehearsalReportFixture(verdict)).verdict).toBe(verdict);
    }
  });

  it("takes stored references only: no action bodies, URLs, methods, tenants or fault JSON", () => {
    const request = rehearsalRequestFixture();
    const { manifest } = happyPathBundle();
    for (const extra of [
      { actions: manifest.actions },
      { manifest },
      { baseUrl: "http://localhost:8101" },
      { method: "POST", path: "/v1/refunds" },
      { tenant: "rehearsal-demo" },
      { orgId: "org_other" },
      { faults: [{ kind: "fault", config: { status: 429 } }] },
    ]) {
      expect(ExecutionRehearsalRequest.safeParse({ ...request, ...extra }).success).toBe(false);
    }
    // Only allowlisted scenarios, never a challenge definition.
    expect(
      ExecutionRehearsalRequest.safeParse({ ...request, scenario: { id: "custom", version: 1 } })
        .success,
    ).toBe(false);
    expect(
      ExecutionRehearsalRequest.safeParse({
        ...request,
        scenario: { id: "clean", version: 1, challenges: [{ kind: "fault" }] },
      }).success,
    ).toBe(false);
    expect(
      ExecutionRehearsalJob.safeParse({ ...rehearsalJobFixture(), world: "operational" }).success,
    ).toBe(false);
  });

  it("never parses as an approval grant or an adoptable operational receipt", () => {
    const report = rehearsalReportFixture();
    const step = report.steps[0]?.result;
    expect(RehearsalStepResult.parse(step)).toBeTruthy();
    expect(Receipt.safeParse(step).success).toBe(false);
    // Not even with an approval ID and protection added by mistake: its world and key stay.
    const adopted = { ...step, approvalId: "grant_1", protection: "no_atomic_guard" };
    expect(RehearsalStepResult.safeParse(adopted).success).toBe(false);
    for (const value of [report, rehearsalJobFixture(), rehearsalRequestFixture(), step]) {
      expect(ApprovalGrant.safeParse(value).success).toBe(false);
    }
    // A rehearsal world can't appear in a plan's evidence.
    const obs = happyPathBundle().manifest.observations[0];
    expect(Observation.safeParse({ ...obs, world: "rehearsal" }).success).toBe(false);
  });

  it("refuses a report whose verdict its steps don't support", () => {
    const unknown = rehearsalReportFixture("unknown");
    expect(ExecutionRehearsalReport.safeParse({ ...unknown, verdict: "passed" }).success).toBe(
      false,
    );
    expect(ExecutionRehearsalReport.safeParse({ ...unknown, verdict: "failed" }).success).toBe(
      false,
    );
    const failed = rehearsalReportFixture("failed");
    expect(ExecutionRehearsalReport.safeParse({ ...failed, verdict: "passed" }).success).toBe(
      false,
    );
    const cancelled = { ...rehearsalReportFixture(), state: "cancelled" };
    expect(ExecutionRehearsalReport.safeParse(cancelled).success).toBe(false);
    expect(ExecutionRehearsalReport.safeParse({ ...cancelled, verdict: "unknown" }).success).toBe(
      true,
    );
    expect(ExecutionRehearsalReport.safeParse({ ...unknown, steps: [] }).success).toBe(true);
    expect(
      ExecutionRehearsalReport.safeParse({ ...rehearsalReportFixture(), steps: [] }).success,
    ).toBe(false);
  });

  it("refuses a pass for a step with no recorded result, however it is labelled (#241)", () => {
    const report = rehearsalReportFixture();
    const [first, ...rest] = report.steps;
    if (!first) throw new Error("fixture has no steps");
    const missing = {
      ...report,
      steps: [
        { ...first, result: null, verification: { status: "matched", detail: "ok" } },
        ...rest,
      ],
    };
    expect(report.state).toBe("completed");
    expect(ExecutionRehearsalReport.safeParse(missing).success).toBe(false);
    // The same report is representable as unknown, and so are a failed or cancelled run's
    // steps that never ran.
    expect(ExecutionRehearsalReport.safeParse({ ...missing, verdict: "unknown" }).success).toBe(
      true,
    );
    for (const state of ["failed", "cancelled"] as const) {
      expect(
        ExecutionRehearsalReport.safeParse({ ...missing, state, verdict: "unknown" }).success,
      ).toBe(true);
    }
    // An explicit unknown outcome still can't pass.
    const unknownOutcome = rehearsalReportFixture("unknown");
    expect(
      ExecutionRehearsalReport.safeParse({ ...unknownOutcome, verdict: "passed" }).success,
    ).toBe(false);
  });

  it("refuses a step result from another rehearsal or plan, or with an operational key", () => {
    const report = rehearsalReportFixture();
    const [first, ...rest] = report.steps;
    if (!first?.result) throw new Error("no step");
    const swap = (result: object) => ({
      ...report,
      steps: [{ ...first, result: { ...first.result, ...result } }, ...rest],
    });
    for (const change of [
      { rehearsalId: "other0001" },
      { planHash: "f".repeat(64) },
      { actionId: "patch_002" },
      { operationKey: rehearsalOperationKey("other0001", "op_refund_001") },
    ]) {
      expect(ExecutionRehearsalReport.safeParse(swap(change)).success).toBe(false);
    }
    expect(RehearsalStepResult.safeParse({ ...first.result, operationKey: "op_1" }).success).toBe(
      false,
    );
  });

  it("namespaces the tenant and operation keys away from operational ones", () => {
    expect(rehearsalTenant(FIXTURE_REHEARSAL_ID)).toBe("rh-fixture0001");
    expect(rehearsalOperationKey(FIXTURE_REHEARSAL_ID, "op_abc")).toBe("rh_fixture0001_op_abc");
    expect(
      ExecutionRehearsalJob.safeParse({ ...rehearsalJobFixture(), rehearsalId: "Rh-1" }).success,
    ).toBe(false);
  });

  it("binds the snapshot to the plan's own evidence", () => {
    const { manifest } = happyPathBundle();
    expect(rehearsalJobFixture().snapshot.digest).toBe(snapshotDigest(manifest));
    const changed = structuredClone(manifest);
    (changed.observations[0] as { fingerprint: string }).fingerprint = "0".repeat(64);
    expect(snapshotDigest(changed)).not.toBe(snapshotDigest(manifest));
  });

  it("leaves existing manifests and their hashes as they were", () => {
    const { manifest } = happyPathBundle();
    expect(PlanManifest.parse(manifest)).toEqual(manifest);
    // A report refers to a hash; it is not part of one. Pinned from the commit before T1.21.
    expect(planHash(manifest)).toBe(
      "4a12c7884ef2fad0a7a0921bcf7b570346d01c7649c9774dbc1fc821f11503ff",
    );
  });
});

describe("rehearsal report staleness (T1.21)", () => {
  const report = rehearsalReportFixture();
  const current = {
    latestRevision: report.plan.revision,
    viewedPlanHash: report.plan.planHash,
    policy: report.policy,
    versions: (({ commit: _c, ...rest }) => rest)(FIXTURE_REHEARSAL_VERSIONS),
    now: new Date(Date.parse(report.finishedAt) + 60_000),
  };

  it("is current for the same plan, policy and build within the window", () => {
    expect(rehearsalStaleness(report, current)).toEqual([]);
    // Another commit that runs the same engine, worker, verifier, projections and images.
    expect(
      rehearsalStaleness(
        { ...report, versions: { ...report.versions, commit: "1234567" } },
        current,
      ),
    ).toEqual([]);
  });

  it("ignores the commit on either side, even in a caller's full versions object (#240)", () => {
    // A caller may pass its whole build object, commit included: same build, current.
    const full: RehearsalVersions = { ...report.versions };
    expect(rehearsalStaleness(report, { ...current, versions: full })).toEqual([]);
    // Only the current commit differs: still current.
    expect(
      rehearsalStaleness(report, { ...current, versions: { ...full, commit: "abcdef0" } }),
    ).toEqual([]);
  });

  it.each<[string, Partial<RehearsalVersions>]>([
    ["engine", { engine: "engine-next" }],
    ["worker", { worker: "worker-next" }],
    ["verifier", { verifier: "verifier-next" }],
    ["projections", { projections: { stripe: "stripe.charge.v9" } }],
    ["images", { images: { stripe: `sha256:${"c".repeat(64)}` } }],
  ])("is stale when the %s changes, with or without a commit alongside", (_field, change) => {
    const full: RehearsalVersions = { ...report.versions, ...change };
    expect(rehearsalStaleness(report, { ...current, versions: full })).toEqual([
      "versions_changed",
    ]);
    const { commit: _c, ...noCommit } = full;
    expect(rehearsalStaleness(report, { ...current, versions: noCommit })).toEqual([
      "versions_changed",
    ]);
  });

  it("names each reason a report no longer describes what the reviewer sees", () => {
    expect(rehearsalStaleness(report, { ...current, latestRevision: 2 })).toEqual([
      "newer_revision",
    ]);
    expect(rehearsalStaleness(report, { ...current, viewedPlanHash: "e".repeat(64) })).toEqual([
      "different_hash",
    ]);
    expect(
      rehearsalStaleness(report, { ...current, policy: { id: "billing-remedy", version: 2 } }),
    ).toEqual(["policy_changed"]);
    expect(
      rehearsalStaleness(report, {
        ...current,
        versions: { ...current.versions, images: { stripe: `sha256:${"c".repeat(64)}` } },
      }),
    ).toEqual(["versions_changed"]);
    expect(
      rehearsalStaleness(report, {
        ...current,
        now: new Date(Date.parse(report.finishedAt) + REHEARSAL_REPORT_TTL_MS),
      }),
    ).toEqual(["expired"]);
    expect(rehearsalStaleness(report, { ...current, now: new Date("not a date") })).toEqual([
      "expired",
    ]);
  });

  it("is served next to the stored report, never written into it", () => {
    const view = { report, stale: rehearsalStaleness(report, { ...current, latestRevision: 3 }) };
    expect(ExecutionRehearsalReportView.parse(view).stale).toEqual(["newer_revision"]);
    expect(ExecutionRehearsalReport.safeParse({ ...report, stale: [] }).success).toBe(false);
  });
});
