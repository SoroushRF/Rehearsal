import type {
  ExecutionRehearsalJob,
  ExecutionRehearsalReport,
  ExecutionRehearsalRequest,
  RehearsalScenarioId,
  RehearsalStepOutcome,
  RehearsalStepReport,
  RehearsalVersions,
} from "@rehearsal/contracts";
import {
  CHALLENGE_CATALOG_VERSION,
  challengesDigest,
  lookupScenario,
  planHash,
  rehearsalOperationKey,
  resolveScenario,
  snapshotDigest,
} from "@rehearsal/core";
import { happyPathBundle } from "./bundles";

/**
 * T1.21 fixtures: one execution rehearsal of the happy-path plan, as request, job and report, for
 * the UI (T2.19-T2.21), storage and runner (T3.13-T3.16) and verifier (T4.12) to build against
 * before any of it runs. Evidence is `fixture`: nothing here ran in a disposable Era world.
 */
export const FIXTURE_REHEARSAL_ID = "fixture0001";

const FINISHED_AT = "2026-10-21T11:10:00.000Z";

export const FIXTURE_REHEARSAL_VERSIONS: RehearsalVersions = {
  commit: "0000000",
  engine: "executor@1",
  worker: "rehearsal-worker@0.0.0",
  verifier: "verifier@0.0.0",
  projections: { stripe: "stripe.charge.v2", zendesk: "zendesk.ticket.v2" },
  images: { stripe: `sha256:${"a".repeat(64)}`, zendesk: `sha256:${"b".repeat(64)}` },
};

function plan() {
  const { manifest } = happyPathBundle();
  return {
    manifest,
    ref: {
      orgId: manifest.orgId,
      planId: manifest.planId,
      revision: manifest.revision,
      planHash: planHash(manifest),
    },
  };
}

export function rehearsalRequestFixture(): ExecutionRehearsalRequest {
  const { ref } = plan();
  return {
    planId: ref.planId,
    revision: ref.revision,
    planHash: ref.planHash,
    scenario: { id: "clean", version: CHALLENGE_CATALOG_VERSION },
  };
}

export function rehearsalJobFixture(): ExecutionRehearsalJob {
  const { manifest, ref } = plan();
  return {
    world: "rehearsal",
    rehearsalId: FIXTURE_REHEARSAL_ID,
    plan: ref,
    scenario: { id: "clean", version: CHALLENGE_CATALOG_VERSION },
    snapshot: { kind: "plan-evidence", digest: snapshotDigest(manifest) },
    policy: manifest.policies[0] ?? { id: "billing-remedy", version: 1 },
    requestedBy: "user_support",
    requestedAt: "2026-10-21T11:00:00.000Z",
  };
}

/**
 * `passed`: the clean control, every step confirmed as expected. `failed`: a phantom charge that the
 * scenario expects held, but which was refunded. `unknown`: a lost response still unknown at the end.
 */
export function rehearsalReportFixture(
  verdict: "passed" | "failed" | "unknown" = "passed",
): ExecutionRehearsalReport {
  const { manifest, ref } = plan();
  const job = rehearsalJobFixture();
  const scenarioId: RehearsalScenarioId =
    verdict === "passed"
      ? "clean"
      : verdict === "failed"
        ? "phantom_membership"
        : "lost_response_restart";
  const scenario = { id: scenarioId, version: CHALLENGE_CATALOG_VERSION };
  const definition = lookupScenario(scenario);
  const bound = resolveScenario(manifest, scenario);
  if (!definition || !bound.ok) throw new Error(bound.ok ? "missing scenario" : bound.reason);
  const expectedOf = new Map(bound.scenario.steps.map((step) => [step.actionId, step.outcome]));
  const steps = manifest.actions.map((action): RehearsalStepReport => {
    const expected: RehearsalStepOutcome = expectedOf.get(action.id) ?? "confirmed";
    let outcome: RehearsalStepOutcome = "confirmed";
    // A corrupted run: the phantom's refund and note went out anyway.
    if (verdict === "failed" && (action.id === "refund_001" || action.id === "note_001")) {
      outcome = "confirmed";
    }
    if (verdict === "unknown" && action.id === "refund_001") outcome = "unknown_outcome";
    // Its note waits on that refund, so neither can be called right or wrong.
    if (verdict === "unknown" && action.id === "note_001") outcome = "skipped_dependency";
    const unverifiable = outcome === "unknown_outcome" || outcome === "skipped_dependency";
    const status = unverifiable ? "unverified" : outcome === expected ? "matched" : "mismatched";
    return {
      actionId: action.id,
      expected,
      result: {
        world: "rehearsal",
        rehearsalId: FIXTURE_REHEARSAL_ID,
        actionId: action.id,
        planHash: ref.planHash,
        operationKey: rehearsalOperationKey(FIXTURE_REHEARSAL_ID, `op_${action.id}`),
        outcome,
        providerRef: null,
        observedEffect: {},
        holdReason: null,
        limitations: outcome === "unknown_outcome" ? ["outcome still unknown after reads"] : [],
        recordedAt: "2026-10-21T11:05:00.000Z",
      },
      verification: {
        status,
        detail:
          status === "matched"
            ? `read back as ${outcome}`
            : status === "unverified"
              ? "the effect could not be established by reading the tenant"
              : `expected ${expected}, read back as ${outcome}`,
      },
    };
  });
  return {
    world: "rehearsal",
    rehearsalId: FIXTURE_REHEARSAL_ID,
    plan: ref,
    scenario,
    challengesDigest: challengesDigest(definition),
    snapshot: job.snapshot,
    policy: job.policy,
    versions: FIXTURE_REHEARSAL_VERSIONS,
    evidence: "fixture",
    state: "completed",
    verdict,
    steps,
    notFromEvidence: ["stripe.charge.payment_method", "zendesk.ticket.subject"],
    limitations: [],
    startedAt: "2026-10-21T11:01:00.000Z",
    finishedAt: FINISHED_AT,
  };
}
