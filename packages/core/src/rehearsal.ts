import type {
  ExecutionRehearsalReport,
  PlanManifest,
  RehearsalStaleReason,
  RehearsalVersions,
} from "@rehearsal/contracts";
import { canonicalize } from "./canonical";
import { fingerprint } from "./hash";

/** Execution-rehearsal helpers (T1.21, decision 0013). Nothing here reads or writes a world. */

/** The disposable tenant a rehearsal runs in. Derived by the server, never sent by a caller. */
export function rehearsalTenant(rehearsalId: string): string {
  return `rh-${rehearsalId}`;
}

/**
 * The key a rehearsal journals and sends instead of the operational one. Operational keys don't
 * depend on the world, so without the prefix a rehearsal row would read as "already applied".
 */
export function rehearsalOperationKey(rehearsalId: string, operationKey: string): string {
  return `rh_${rehearsalId}_${operationKey}`;
}

/** The `plan-evidence` snapshot digest: what the rehearsal seeds from, and nothing else. */
export function snapshotDigest(
  manifest: Pick<PlanManifest, "observations" | "queryObservations">,
): string {
  return fingerprint({
    observations: manifest.observations,
    queryObservations: manifest.queryObservations,
  });
}

/** A report older than this is stale whatever else holds. Open for T3/T4 review (decision 0013). */
export const REHEARSAL_REPORT_TTL_MS = 24 * 60 * 60 * 1000;

/** What the reviewer is looking at now, and what the current build would run. */
export interface RehearsalReadContext {
  latestRevision: number;
  viewedPlanHash: string;
  /** The policy the viewed plan is evaluated under. */
  policy: { id: string; version: number };
  /** The current build. A `commit` may be present; it is ignored, like the report's. */
  versions: Omit<RehearsalVersions, "commit"> & { commit?: string };
  now: Date;
}

/**
 * The parts of a build that decide what a rehearsal ran. The commit is provenance only, so it is
 * left out on both sides, whatever else a caller's object carries.
 */
function executionVersions(v: Omit<RehearsalVersions, "commit">) {
  return {
    engine: v.engine,
    worker: v.worker,
    verifier: v.verifier,
    projections: v.projections,
    images: v.images,
  };
}

/**
 * Why a stored report no longer describes the plan in front of the reviewer. Computed when the
 * report is read, so the row is never edited. Empty means current. A different commit alone isn't
 * stale: what runs is the engine, worker, verifier, projections and images, and those are compared.
 */
export function rehearsalStaleness(
  report: Pick<ExecutionRehearsalReport, "plan" | "policy" | "versions" | "finishedAt">,
  current: RehearsalReadContext,
): RehearsalStaleReason[] {
  const reasons: RehearsalStaleReason[] = [];
  if (current.latestRevision > report.plan.revision) reasons.push("newer_revision");
  if (current.viewedPlanHash !== report.plan.planHash) reasons.push("different_hash");
  if (current.policy.id !== report.policy.id || current.policy.version !== report.policy.version) {
    reasons.push("policy_changed");
  }
  if (
    canonicalize(executionVersions(report.versions)) !==
    canonicalize(executionVersions(current.versions))
  ) {
    reasons.push("versions_changed");
  }
  const finished = Date.parse(report.finishedAt);
  if (!(current.now.getTime() - finished < REHEARSAL_REPORT_TTL_MS)) reasons.push("expired");
  return reasons;
}
