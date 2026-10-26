import { z } from "zod";
import { Timestamp } from "./common";

/**
 * Live demo: incidents a signed-in org files itself. Each kind is planned with typed operations
 * that already exist; anything else gets an empty plan with a reason.
 */
export const IncidentKind = z.enum(["duplicate_charge", "service_outage", "support_backlog"]);
export type IncidentKind = z.infer<typeof IncidentKind>;

/** What the incident form sends. The window bounds which records the planner considers. */
export const IncidentDraft = z.object({
  kind: IncidentKind,
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(10).max(2000),
  window: z.object({ createdGte: Timestamp, createdLt: Timestamp }),
});
export type IncidentDraft = z.infer<typeof IncidentDraft>;

/** An append-only row. `incidentId` is what `POST /api/incidents/:id/rehearse` takes. */
export const StoredIncident = IncidentDraft.extend({
  incidentId: z.string().regex(/^INC-[A-Z]+-\d{4}$/),
  orgId: z.string().min(1),
  createdAt: Timestamp,
});
export type StoredIncident = z.infer<typeof StoredIncident>;

/** `POST /api/company/problems`: seed the org's own world with records a kind of incident needs. */
export const CreateProblem = z.object({
  preset: IncidentKind,
  count: z.int().min(1).max(5),
});
export type CreateProblem = z.infer<typeof CreateProblem>;
