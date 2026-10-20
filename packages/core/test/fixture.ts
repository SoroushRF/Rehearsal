import type { Action, PlanManifest } from "@rehearsal/contracts";

const HEX = "0".repeat(64);

const base = {
  caseId: "case_1",
  obligationId: "obl_1",
  requiredRole: "support_lead" as const,
  evidence: [] as string[],
  queryEvidence: [] as string[],
  rationale: "test",
};

export const refund: Action = {
  ...base,
  id: "refund_1",
  kind: "stripe.refund.create",
  dependsOn: [],
  compensation: "compensable_by_new_action",
  protection: "native_guard_with_documented_limits",
  args: { chargeId: "ch_1", amount: { amountMinor: 4210, currency: "cad" }, reason: "duplicate" },
};

export const patch: Action = {
  ...base,
  id: "patch_1",
  kind: "zendesk.ticket.patchFields",
  dependsOn: [],
  compensation: "conditional_reversible",
  protection: "native_guard_with_documented_limits",
  args: { ticketId: "1", set: { priority: "high" }, before: { priority: "normal" } },
};

export const note: Action = {
  ...base,
  id: "note_1",
  kind: "zendesk.ticket.appendPrivateNote",
  dependsOn: ["refund_1"],
  compensation: "irreversible",
  protection: "no_atomic_guard",
  args: {
    ticketId: "1",
    public: false,
    template: { id: "refund-confirmed", version: 1 },
    bindings: { refundId: { $ref: "result", stepId: "refund_1", path: "refund.id" } },
  },
};

export function manifest(actions: Action[] = [refund, patch, note]): PlanManifest {
  return {
    schemaVersion: 1,
    orgId: "org_test",
    incidentId: "inc_test",
    planId: "plan_test",
    revision: 1,
    parentRevision: null,
    target: { environment: "operational" },
    versions: {
      planner: { model: "fixture", promptVersion: "fixture", toolSchemaHash: HEX },
      adapters: {},
    },
    policies: [{ id: "billing-remedy", version: 1 }],
    observations: [],
    queryObservations: [],
    actions,
    excluded: [],
  };
}
