import type { PlanManifest } from "@rehearsal/contracts";
import type { ApiFetch } from "../api";
import type { CurrentPlan } from "../execution-rehearsal";
import { shortHash } from "../format";
import type { StepResult } from "../runs";
import { RehearsalReportToggle, useRehearsalReport } from "./RehearsalReport";
import { StepOutcomes } from "./RunTimeline";
import { Card, Chip, Skeleton } from "./ui";

/**
 * A finished simulation, shown the way the run card shows an apply: the outcome bar, the counts
 * and a line per step. It ran in a replica, so it says so, and it approves nothing. The full report
 * (expected against observed, where it came from) stays one click away.
 */
export function SimulationResult({
  apiFetch,
  rehearsalId,
  current,
  manifest,
}: {
  apiFetch: ApiFetch;
  rehearsalId: string;
  current: CurrentPlan;
  /** The plan on screen; null when it isn't loaded. */
  manifest: PlanManifest | null;
}) {
  const q = useRehearsalReport(apiFetch, rehearsalId);
  const details = (
    <RehearsalReportToggle
      apiFetch={apiFetch}
      rehearsalId={rehearsalId}
      current={current}
      manifest={manifest}
      label="Details: expected against observed"
    />
  );
  if (q.isPending) return <Skeleton className="mt-3 h-40" />;
  const report = q.data?.report;
  // Step names come from the plan only when it is the plan the simulation ran on.
  if (!report || !manifest || report.plan.planHash !== current.planHash) return details;

  const results = new Map<string, StepResult>(
    report.steps.flatMap((s) => (s.result ? [[s.actionId, s.result] as const] : [])),
  );
  const allConfirmed = manifest.actions.every((a) => results.get(a.id)?.outcome === "confirmed");
  return (
    <Card
      aria-label="Simulation result"
      data-testid="simulation-result"
      data-all-confirmed={allConfirmed ? "true" : "false"}
      className="mt-3 overflow-hidden"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-4 sm:px-5 sm:pt-5">
        <h3 className="text-base font-semibold text-ink">Simulation</h3>
        <Chip tone={allConfirmed ? "good" : "warn"}>{allConfirmed ? "completed" : "partial"}</Chip>
        <Chip tone="info" icon="flask" hint="Ran in a replica of the company">
          not production
        </Chip>
        <span className="ml-auto text-xs text-subtle">
          revision {report.plan.revision} · hash{" "}
          <code className="font-mono">{shortHash(report.plan.planHash)}</code>
        </span>
      </header>
      <StepOutcomes manifest={manifest} results={results} running={false} />
      <div className="border-t border-line px-4 py-3 sm:px-5">
        <p className="text-sm text-muted">
          Nothing real changed. Approve to apply this exact plan to production, where every step is
          checked again before it is sent.
        </p>
        {details}
      </div>
    </Card>
  );
}
