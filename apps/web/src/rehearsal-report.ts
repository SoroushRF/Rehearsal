import type {
  ExecutionRehearsalReport,
  ExecutionRehearsalReportView,
  RehearsalEvidence,
  RehearsalStaleReason,
  RehearsalStepReport,
} from "@rehearsal/contracts";
import type { Tone } from "./components/ui";
import type { CurrentPlan } from "./execution-rehearsal";

/** Where the report of one rehearsal is read (T2.19). The stored row plus staleness at read time. */
export const rehearsalReportPath = (rehearsalId: string) =>
  `/api/execution-rehearsals/${encodeURIComponent(rehearsalId)}/report`;

export const evidenceLabel: Record<RehearsalEvidence, { text: string; hint: string }> = {
  fixture: {
    text: "Fixture",
    hint: "Built from fixtures. Nothing here ran against real Era images.",
  },
  era_integration: {
    text: "Era simulator",
    hint: "Ran against real Era simulator images in disposable worlds.",
  },
  native_stripe_test: {
    text: "Stripe test mode",
    hint: "Ran against a Stripe test-mode account. That is not an operational world.",
  },
};

const staleCopy: Record<RehearsalStaleReason, string> = {
  newer_revision: "A newer revision of this plan exists, so this report describes an earlier one.",
  different_hash: "This report ran on a different version of the plan than the one on screen.",
  policy_changed: "The policy changed after this ran.",
  versions_changed:
    "The simulator images, projections or executor changed after this ran, so it may not match what runs now.",
  expired: "This report is more than 24 hours old.",
};
export const explainStale = (r: RehearsalStaleReason) => staleCopy[r];

/**
 * Why the report may not describe the plan on screen. The server computes staleness when it reads
 * the report; the page adds the one thing it can see itself, the revision and hash being reviewed,
 * so a report is never presented as current just because the server's answer was cached.
 */
export function staleReasons(
  view: ExecutionRehearsalReportView,
  current: CurrentPlan,
): RehearsalStaleReason[] {
  const out = new Set<RehearsalStaleReason>(view.stale);
  const { plan } = view.report;
  if (plan.revision < current.revision) out.add("newer_revision");
  else if (plan.revision === current.revision && plan.planHash !== current.planHash) {
    out.add("different_hash");
  } else if (plan.revision > current.revision) out.add("different_hash");
  return [...out];
}

export type Tally = { matched: number; mismatched: number; unverified: number };
export function tally(steps: readonly RehearsalStepReport[]): Tally {
  const t: Tally = { matched: 0, mismatched: 0, unverified: 0 };
  for (const s of steps) t[s.verification.status]++;
  return t;
}

export type Headline = { tone: Tone; title: string; body: string };

/**
 * Words for the verdict. "Passed" is never "safe": it means this scenario, on this snapshot, read
 * back as expected. Anything not established is said to be unknown rather than fine.
 */
export function headline(report: ExecutionRehearsalReport, stale: boolean): Headline {
  const where = `under "${report.scenario.id.replaceAll("_", " ")}"`;
  if (report.state === "failed") {
    return {
      tone: "danger",
      title: "The rehearsal failed before it finished",
      body: "Steps with no result never ran. Nothing here shows how the plan behaves; try again or ask an operator.",
    };
  }
  if (report.state === "cancelled") {
    return {
      tone: "warn",
      title: "The rehearsal was cancelled",
      body: "Only the steps that ran are shown. The rest were not tried.",
    };
  }
  switch (report.verdict) {
    case "passed":
      return {
        tone: stale ? "warn" : "good",
        title: `Every step read back as expected ${where}`,
        body: "That is what happened in a disposable copy, once. It does not approve this plan or promise the real world will stay the same.",
      };
    case "failed":
      return {
        tone: "danger",
        title: `Something differed from what was expected ${where}`,
        body: "Look at the highlighted steps before approving. A rehearsal that disagrees with its expectations is a reason to look again, not a verdict by itself.",
      };
    case "unknown":
      return {
        tone: "warn",
        title: `Some outcomes could not be established ${where}`,
        body: "A step is still unknown or never ran. Unknown is not the same as fine.",
      };
  }
}

/** What the executor saw for one step, in a few words. */
export function observedLabel(step: RehearsalStepReport): string {
  const r = step.result;
  if (!r) return "Never ran";
  return OBSERVED[r.outcome];
}
const OBSERVED = {
  confirmed: "Applied",
  rejected: "Refused",
  held: "Held",
  unknown_outcome: "Outcome unknown",
  skipped_dependency: "Skipped",
} as const;

export const expectedLabel = (o: RehearsalStepReport["expected"]) => OBSERVED[o];

export const verificationLabel: Record<
  RehearsalStepReport["verification"]["status"],
  { text: string; tone: Tone }
> = {
  matched: { text: "As expected", tone: "good" },
  mismatched: { text: "Not as expected", tone: "danger" },
  unverified: { text: "Not established", tone: "warn" },
};
