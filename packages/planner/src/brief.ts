import type { PlanManifest } from "@rehearsal/contracts";
import type { PlanJobIncident, PlanJobRepair } from "@rehearsal/providers";
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
  support_backlog: "Customer tickets may be waiting for a first reply.",
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
    ...(incident.kind === "support_backlog" && { mode: "backlog" as const }),
    summary: KIND_SUMMARY[incident.kind],
    report: { title: incident.title, description: incident.description },
    window: incident.window,
    customers: base.customers,
  };
}

/**
 * T1.37: the brief for a repair. Only the open cases' customers are planned again, told what the
 * base revision already applied and why the rest stopped. Undefined when an open case has no
 * customer in the brief: planning the others would quietly drop that case's work.
 */
export function repairBrief(
  brief: IncidentBrief,
  repair: PlanJobRepair,
): IncidentBrief | undefined {
  const open = new Set(repair.openCases);
  const customers = brief.customers.filter((c) => open.has(`case_${c.customerId}`));
  if (customers.length !== open.size) return undefined;
  const kept = new Set(repair.kept);
  return {
    ...brief,
    customers,
    repair: {
      baseRevision: repair.base.revision,
      kept: repair.base.actions
        .filter((a) => kept.has(a.id))
        .map((a) => ({ id: a.id, kind: a.kind, caseId: a.caseId })),
      stopped: repair.stopped,
    },
  };
}

/** The base revision's confirmed steps and exactly the evidence they cite, for `adopt`. */
export function keptSteps(
  repair: PlanJobRepair,
): Pick<PlanManifest, "actions" | "observations" | "queryObservations"> {
  const kept = new Set(repair.kept);
  const actions = repair.base.actions.filter((a) => kept.has(a.id));
  const observations = new Set(actions.flatMap((a) => a.evidence));
  const queries = new Set(actions.flatMap((a) => a.queryEvidence));
  return {
    actions,
    observations: repair.base.observations.filter((o) => observations.has(o.id)),
    queryObservations: repair.base.queryObservations.filter((q) => queries.has(q.id)),
  };
}
