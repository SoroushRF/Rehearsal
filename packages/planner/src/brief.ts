import type { PlanJobIncident } from "@rehearsal/providers";
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

/** The summary each kind gives the agent, beside the filer's own report. */
const KIND_SUMMARY: Record<PlanJobIncident["kind"], string> = {
  duplicate_charge: "Customers may have been charged more than once for the same invoice.",
  service_outage: "Customers may be owed a credit for a service outage.",
  support_backlog: "Customer tickets may be waiting at the wrong priority.",
};

/**
 * Live demo (#331): the brief for an incident the org filed. The customer roster is the company's,
 * from the server, never from the filer; the filer's words go in as a fenced report.
 */
export function storedIncidentBrief(
  incident: PlanJobIncident,
  spec: IncidentSpec = INCIDENT,
): IncidentBrief {
  const base = incidentBrief(spec.incident, spec) as IncidentBrief;
  return {
    incident: incident.incidentId,
    summary: KIND_SUMMARY[incident.kind],
    report: { title: incident.title, description: incident.description },
    window: incident.window,
    customers: base.customers,
  };
}
