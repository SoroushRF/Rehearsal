import { z } from "zod";
import { EntityRef, Sha256Hex, Timestamp, Vendor } from "./common";
import { HoldReason } from "./execution";

/**
 * T1.21: wire types for an execution rehearsal (decision 0013). A stored, exact plan runs in
 * disposable Era worlds under an allowlisted scenario, and the report shows what happened before
 * anyone approves it for the operational world. This is not the incident-to-plan "rehearse" job,
 * where the planner works in the planning world; that one keeps its own types in `api.ts`.
 *
 * A rehearsal never grants anything. Its rows carry `world: "rehearsal"` and no approval ID, so none
 * of them parses as an `ApprovalGrant` or an operational `Receipt`. Nothing here feeds a plan hash.
 */

/**
 * The disposable worlds a rehearsal runs in. Deliberately not part of `World`: a plan manifest's
 * evidence and an operational receipt can never name it.
 */
export const RehearsalWorld = z.literal("rehearsal");

/** Server-chosen. The tenant is `rh-<id>` and every operation key is `rh_<id>_<key>`. */
export const ExecutionRehearsalId = z.string().regex(/^[a-z0-9]{8,32}$/, "a server-chosen ID");
export type ExecutionRehearsalId = z.infer<typeof ExecutionRehearsalId>;

/** The rehearsal-namespaced operation key: never equal to an operational one (decision 0013, §3). */
export const RehearsalOperationKey = z.string().regex(/^rh_[a-z0-9]{8,32}_.+$/);

/**
 * The allowlisted scenarios (T4.11 versions their challenges). `clean` is the control with no
 * challenge. A caller names one; it never sends a challenge or a fault body itself.
 */
export const RehearsalScenarioId = z.enum([
  "clean",
  "phantom_membership",
  "teammate_field_edit",
  "lost_response_restart",
  "benign_nonmatching_change",
]);
export type RehearsalScenarioId = z.infer<typeof RehearsalScenarioId>;

export const RehearsalScenarioRef = z.strictObject({
  id: RehearsalScenarioId,
  version: z.int().positive(),
});
export type RehearsalScenarioRef = z.infer<typeof RehearsalScenarioRef>;

/** The plan's own cited evidence, fingerprinted. The only snapshot kind (decision 0013, §4). */
export const RehearsalSnapshotRef = z.strictObject({
  kind: z.literal("plan-evidence"),
  digest: Sha256Hex,
});
export type RehearsalSnapshotRef = z.infer<typeof RehearsalSnapshotRef>;

/** A stored plan, exactly: the rehearsal loads its manifest, never actions from a caller. */
export const StoredPlanRef = z.strictObject({
  orgId: z.string().min(1),
  planId: z.string().min(1),
  revision: z.int().positive(),
  planHash: Sha256Hex,
});
export type StoredPlanRef = z.infer<typeof StoredPlanRef>;

/** The policy the stored plan was evaluated under, not today's file. */
export const RehearsalPolicyRef = z.strictObject({
  id: z.string().min(1),
  version: z.int().positive(),
});

/** What produced the result. Any difference from the current build makes a report stale. */
export const RehearsalVersions = z.strictObject({
  commit: z.string().regex(/^[0-9a-f]{7,40}$/),
  engine: z.string().min(1),
  worker: z.string().min(1),
  verifier: z.string().min(1),
  /** Provider projection versions, e.g. `stripe.charge.v2`, by vendor. */
  projections: z.partialRecord(Vendor, z.string().min(1)),
  /** Era image digests from `infra/compose.yaml`, by vendor. */
  images: z.partialRecord(Vendor, z.string().regex(/^sha256:[0-9a-f]{64}$/)),
});
export type RehearsalVersions = z.infer<typeof RehearsalVersions>;

/**
 * How far a result may be trusted. `fixture` until run on real Era images; a test-mode Stripe
 * account is labelled on its own and never stands in for an operational world.
 */
export const RehearsalEvidence = z.enum(["fixture", "era_integration", "native_stripe_test"]);
export type RehearsalEvidence = z.infer<typeof RehearsalEvidence>;

/**
 * What the browser or API caller may send: references to stored rows only. Strict, so action
 * bodies, URLs, methods, tenants or fault JSON are a validation error. The org comes from the
 * verified session, never from the body.
 */
export const ExecutionRehearsalRequest = z.strictObject({
  planId: z.string().min(1),
  revision: z.int().positive(),
  planHash: Sha256Hex,
  scenario: RehearsalScenarioRef,
});
export type ExecutionRehearsalRequest = z.infer<typeof ExecutionRehearsalRequest>;

/** The queued job, built by the server from a request it admitted (T3.13 queue `rehearsal`). */
export const ExecutionRehearsalJob = z.strictObject({
  world: RehearsalWorld,
  rehearsalId: ExecutionRehearsalId,
  plan: StoredPlanRef,
  scenario: RehearsalScenarioRef,
  snapshot: RehearsalSnapshotRef,
  policy: RehearsalPolicyRef,
  requestedBy: z.string().min(1),
  requestedAt: Timestamp,
});
export type ExecutionRehearsalJob = z.infer<typeof ExecutionRehearsalJob>;

/** queued → provisioning → running → verifying → completed | failed | cancelled. */
export const ExecutionRehearsalState = z.enum([
  "queued",
  "provisioning",
  "running",
  "verifying",
  "completed",
  "failed",
  "cancelled",
]);
export type ExecutionRehearsalState = z.infer<typeof ExecutionRehearsalState>;
export const TERMINAL_REHEARSAL_STATES = ["completed", "failed", "cancelled"] as const;

/** One state change. Append-only: the current state is the last event, nothing is edited. */
export const ExecutionRehearsalEvent = z.strictObject({
  rehearsalId: ExecutionRehearsalId,
  seq: z.int().nonnegative(),
  state: ExecutionRehearsalState,
  at: Timestamp,
  /** Why it failed or was cancelled, or what provisioning refused. */
  detail: z.string().nullable(),
  /** Set once the tenant has been reset; teardown is idempotent and may follow any terminal state. */
  tornDownAt: Timestamp.nullable(),
});
export type ExecutionRehearsalEvent = z.infer<typeof ExecutionRehearsalEvent>;

/** A step's outcome in the rehearsal. No compensation outcomes: a rehearsal only reads them back. */
export const RehearsalStepOutcome = z.enum([
  "confirmed",
  "rejected",
  "held",
  "unknown_outcome",
  "skipped_dependency",
]);
export type RehearsalStepOutcome = z.infer<typeof RehearsalStepOutcome>;

/**
 * What the executor recorded for one step in the disposable world. It has no approval ID or
 * protection level, so it is never an operational `Receipt` and can't be adopted as one.
 */
export const RehearsalStepResult = z.strictObject({
  world: RehearsalWorld,
  rehearsalId: ExecutionRehearsalId,
  actionId: z.string().min(1),
  planHash: Sha256Hex,
  operationKey: RehearsalOperationKey,
  outcome: RehearsalStepOutcome,
  providerRef: EntityRef.nullable(),
  /** What a read showed after the write, not what was expected. */
  observedEffect: z.record(z.string(), z.unknown()),
  holdReason: HoldReason.nullable(),
  limitations: z.array(z.string()),
  recordedAt: Timestamp,
});
export type RehearsalStepResult = z.infer<typeof RehearsalStepResult>;

/** The independent verifier's read of one step (T4.12), against what the scenario expects. */
export const RehearsalVerification = z.strictObject({
  status: z.enum(["matched", "mismatched", "unverified"]),
  detail: z.string().min(1),
});

export const RehearsalStepReport = z.strictObject({
  actionId: z.string().min(1),
  /** From the scenario, written before the run; never derived from the result. */
  expected: RehearsalStepOutcome,
  /** Null when the step never ran (the run failed or was cancelled first). */
  result: RehearsalStepResult.nullable(),
  verification: RehearsalVerification,
});
export type RehearsalStepReport = z.infer<typeof RehearsalStepReport>;

/**
 * `passed` only when every step was verified as expected and none is still unknown; `failed` only
 * when a step was verified as not what the scenario expects. Anything else is `unknown`: a step left
 * unknown at the end, or one with no recorded result, never reads as passed (decision 0013, §5).
 */
export const RehearsalVerdict = z.enum(["passed", "failed", "unknown"]);

/** The immutable report. Staleness is computed when it is read, never stored. */
export const ExecutionRehearsalReport = z
  .strictObject({
    world: RehearsalWorld,
    rehearsalId: ExecutionRehearsalId,
    plan: StoredPlanRef,
    scenario: RehearsalScenarioRef,
    /** Digest of the scenario's challenge list as it ran. */
    challengesDigest: Sha256Hex,
    snapshot: RehearsalSnapshotRef,
    policy: RehearsalPolicyRef,
    versions: RehearsalVersions,
    evidence: RehearsalEvidence,
    state: z.enum(TERMINAL_REHEARSAL_STATES),
    verdict: RehearsalVerdict,
    steps: z.array(RehearsalStepReport),
    /** Seeded fields that didn't come from the plan's evidence (fixture defaults). */
    notFromEvidence: z.array(z.string()),
    limitations: z.array(z.string()),
    startedAt: Timestamp,
    finishedAt: Timestamp,
  })
  .superRefine((report, ctx) => {
    for (const [i, step] of report.steps.entries()) {
      const r = step.result;
      if (!r) continue;
      if (
        r.rehearsalId !== report.rehearsalId ||
        r.planHash !== report.plan.planHash ||
        r.actionId !== step.actionId
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", i, "result"],
          message: "step result belongs to another rehearsal, plan or step",
        });
      }
      if (!r.operationKey.startsWith(`rh_${report.rehearsalId}_`)) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", i, "result", "operationKey"],
          message: "operation key is not namespaced to this rehearsal",
        });
      }
    }
    // A step with no recorded result never ran, so nothing about it can count as verified.
    const unknown = report.steps.some(
      (s) =>
        s.result === null ||
        s.result.outcome === "unknown_outcome" ||
        s.verification.status === "unverified",
    );
    const allMatched =
      report.state === "completed" &&
      report.steps.length > 0 &&
      report.steps.every((s) => s.verification.status === "matched");
    if (report.verdict === "passed" && (unknown || !allMatched)) {
      ctx.addIssue({
        code: "custom",
        path: ["verdict"],
        message: "passed needs a completed run with every step verified as expected",
      });
    }
    if (report.verdict === "failed" && !report.steps.some(mismatched)) {
      ctx.addIssue({
        code: "custom",
        path: ["verdict"],
        message: "failed needs a step verified as not what the scenario expects; otherwise unknown",
      });
    }
  });
export type ExecutionRehearsalReport = z.infer<typeof ExecutionRehearsalReport>;

const mismatched = (s: RehearsalStepReport) => s.verification.status === "mismatched";

/** Why a report no longer describes what the reviewer is looking at (decision 0013, §1). */
export const RehearsalStaleReason = z.enum([
  "newer_revision",
  "different_hash",
  "policy_changed",
  "versions_changed",
  "expired",
]);
export type RehearsalStaleReason = z.infer<typeof RehearsalStaleReason>;

/** A report as the API returns it: the stored row plus staleness computed at read time. */
export const ExecutionRehearsalReportView = z.strictObject({
  report: ExecutionRehearsalReport,
  stale: z.array(RehearsalStaleReason),
});
export type ExecutionRehearsalReportView = z.infer<typeof ExecutionRehearsalReportView>;
