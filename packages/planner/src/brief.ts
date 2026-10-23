import { INCIDENT, type IncidentSpec } from "@rehearsal/testkit";
import type { IncidentBrief } from "./prompt";

/**
 * The incident reports the planner knows. A plan job names an incident by ID; the brief comes from
 * here, never from the job, so a job can't smuggle instructions into the prompt.
 */
export function incidentBrief(
  incidentId: string,
  spec: IncidentSpec = INCIDENT,
): IncidentBrief | undefined {
  if (incidentId !== spec.incident) return undefined;
  return {
    incident: spec.incident,
    summary: spec.summary,
    window: spec.window,
    // Only who reported it. The case kind, amounts and charge IDs are for the agent to find.
    customers: spec.cases.map((c) => ({
      customerId: c.customerId,
      name: c.name,
      requesterId: String(c.requesterId),
    })),
  };
}
