import {
  ExecutionRehearsalId,
  type ExecutionRehearsalRequest,
  ExecutionRehearsalState,
  type RehearsalScenarioId,
  RehearsalScenarioRef,
  StoredPlanRef,
  TERMINAL_REHEARSAL_STATES,
} from "@rehearsal/contracts";
import { z } from "zod";
import { RefusedError } from "./api";

/**
 * Execution rehearsal (decision 0013, T2.20): a stored plan runs in disposable worlds under an
 * allowlisted scenario. This is not the incident rehearsal in `components/Rehearse.tsx`, where the
 * planner makes a plan; the two have separate routes and types.
 *
 * The routes below are what T2.19 (#171) serves. The browser sends references to the stored plan
 * and a scenario and nothing else: no actions, URLs, faults or tenants.
 */
export const executionRehearsalsPath = (planId: string) =>
  `/api/plans/${encodeURIComponent(planId)}/execution-rehearsals`;

/** One rehearsal as the list shows it. Detail says why it failed or was cancelled. */
export const ExecutionRehearsalSummary = z.object({
  rehearsalId: ExecutionRehearsalId,
  plan: StoredPlanRef,
  scenario: RehearsalScenarioRef,
  state: ExecutionRehearsalState,
  detail: z.string().nullable(),
  requestedBy: z.string(),
  requestedAt: z.string(),
  updatedAt: z.string(),
});
export type ExecutionRehearsalSummary = z.infer<typeof ExecutionRehearsalSummary>;

export const ExecutionRehearsalList = z.object({
  rehearsals: z.array(ExecutionRehearsalSummary),
});

/** `existing`: an identical request was already admitted, so this is that job, not a new one. */
export const ExecutionRehearsalStarted = z.object({
  rehearsal: ExecutionRehearsalSummary,
  existing: z.boolean(),
});
export type ExecutionRehearsalStarted = z.infer<typeof ExecutionRehearsalStarted>;

export type ScenarioInfo = { id: RehearsalScenarioId; title: string; what: string };

/** The challenges a reviewer can choose, in plain words. Versions come from the server's refusal. */
export const SCENARIOS: readonly ScenarioInfo[] = [
  {
    id: "clean",
    title: "Clean control",
    what: "Nothing goes wrong. Shows what the plan does when the world matches the evidence.",
  },
  {
    id: "phantom_membership",
    title: "A new duplicate charge appears",
    what: "A charge that wasn't in the evidence shows up. The plan should hold that customer's refund.",
  },
  {
    id: "teammate_field_edit",
    title: "A teammate edits a ticket",
    what: "Someone changes a field the plan is about to write. Their edit should survive.",
  },
  {
    id: "lost_response_restart",
    title: "A lost response and a restart",
    what: "A write lands but its reply is lost. The outcome should be read back, never re-sent.",
  },
  {
    id: "benign_nonmatching_change",
    title: "An unrelated change (control)",
    what: "Something changes that doesn't concern the plan. Nothing should be held for it.",
  },
];
export const scenarioInfo = (id: RehearsalScenarioId): ScenarioInfo =>
  SCENARIOS.find((s) => s.id === id) ?? { id, title: id, what: "" };

/** Every scenario starts at version 1 until T4.11 versions its challenges. */
export const SCENARIO_VERSION = 1;

export type StateCopy = { label: string; say: string };
export const stateCopy: Record<ExecutionRehearsalState, StateCopy> = {
  queued: { label: "Queued", say: "Waiting for a disposable copy to be free." },
  provisioning: {
    label: "Preparing",
    say: "Setting up the disposable copy from the plan's evidence.",
  },
  running: { label: "Running", say: "Applying the plan to the disposable copy." },
  verifying: { label: "Checking", say: "Reading the disposable copy back to see what happened." },
  completed: {
    label: "Finished",
    say: "Finished. The report compares what happened with what was expected.",
  },
  failed: { label: "Failed", say: "The rehearsal could not finish." },
  cancelled: { label: "Cancelled", say: "The rehearsal was cancelled before it finished." },
};

export const STAGES = ["queued", "provisioning", "running", "verifying"] as const;
export const isTerminal = (s: ExecutionRehearsalState) =>
  (TERMINAL_REHEARSAL_STATES as readonly string[]).includes(s);

/** What a rehearsal is about, relative to the revision the reviewer is looking at. */
export type CurrentPlan = { planId: string; revision: number; planHash: string };
export type Relation = "current" | "older_revision" | "other_hash";

/**
 * A rehearsal stays tied to the revision and hash it ran on. When the reviewer is looking at a
 * different one it is shown as such and never counts for the plan on screen.
 */
export function relationTo(r: ExecutionRehearsalSummary, current: CurrentPlan): Relation {
  if (r.plan.revision === current.revision) {
    return r.plan.planHash === current.planHash ? "current" : "other_hash";
  }
  return "older_revision";
}

/** The request for what is on screen. Strict by contract: nothing else can be sent. */
export function requestFor(
  current: CurrentPlan,
  scenario: RehearsalScenarioId,
): ExecutionRehearsalRequest {
  return {
    planId: current.planId,
    revision: current.revision,
    planHash: current.planHash,
    scenario: { id: scenario, version: SCENARIO_VERSION },
  };
}

/** A job for this exact plan and scenario that is still going. Starting it again would queue a copy. */
export function activeFor(
  list: readonly ExecutionRehearsalSummary[],
  current: CurrentPlan,
  scenario: RehearsalScenarioId,
): ExecutionRehearsalSummary | undefined {
  return list.find(
    (r) =>
      !isTerminal(r.state) && r.scenario.id === scenario && relationTo(r, current) === "current",
  );
}

/** Newest first, by when each was requested. */
export const newestFirst = (list: readonly ExecutionRehearsalSummary[]) =>
  [...list].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));

/** True when the server has no execution rehearsal at all (T2.19 not deployed, or switched off). */
export const isUnavailable = (err: unknown) =>
  err instanceof RefusedError && [404, 501, 503].includes(err.status);

/** One sentence a reviewer can act on for every refusal the rehearsal routes give. */
export function explainRehearsalRefusal(err: unknown): string | null {
  if (!(err instanceof RefusedError)) return null;
  const r = err.refusal;
  switch (r.error) {
    case "stale_revision":
      return `A newer revision (${r.latestRevision ?? "?"}) exists. Reload to rehearse that one.`;
    case "hash_mismatch":
      return "This plan changed since you loaded it. Reload to rehearse the current version.";
    case "unsupported_snapshot":
      return `This plan's evidence can't be copied into a disposable world${r.detail ? `: ${r.detail}` : "."}`;
    case "unknown_scenario":
    case "unsupported_scenario":
      return "That scenario isn't available on this server.";
    case "forbidden":
    case "missing_roles":
      return "Your role can read plans but not start a rehearsal.";
    case "world_busy":
      return "The disposable worlds are in use. Try again in a minute.";
    default:
      return null;
  }
}
