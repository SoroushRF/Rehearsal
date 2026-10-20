import type {
  Action,
  Observation,
  PlanManifest,
  QueryObservation,
  ReplayBundle,
} from "@rehearsal/contracts";
import { fingerprint } from "@rehearsal/core";

/**
 * Shared development fixtures (evidence: "fixture"). IDs are placeholders until A replaces them
 * with records copied from real Era GET responses. Two customer cases:
 *   case_001: 42.10 CAD duplicate charge  → refund (support lead), raise ticket priority, private note
 *   case_002: 125.00 CAD duplicate charge → refund (finance lead: over threshold), same ticket steps
 */

const CAPTURED_AT = "2026-10-01T12:00:00.000Z";
const WINDOW = { createdGte: "2026-09-01T00:00:00.000Z", createdLt: "2026-10-01T00:00:00.000Z" };

interface CaseSpec {
  n: string;
  customerId: string;
  chargeId: string;
  ticketId: string;
  amountMinor: number;
  role: Action["requiredRole"];
}

const CASES: CaseSpec[] = [
  {
    n: "001",
    customerId: "cus_fixture_001",
    chargeId: "ch_fixture_001",
    ticketId: "5531",
    amountMinor: 4210,
    role: "support_lead",
  },
  {
    n: "002",
    customerId: "cus_fixture_002",
    chargeId: "ch_fixture_002",
    ticketId: "5532",
    amountMinor: 12500,
    role: "finance_lead",
  },
];

function chargeProjection(c: CaseSpec) {
  return {
    id: c.chargeId,
    customer: c.customerId,
    amount: c.amountMinor,
    amount_refunded: 0,
    currency: "cad",
    status: "succeeded",
  };
}

function observationsFor(c: CaseSpec): { obs: Observation[]; query: QueryObservation } {
  const charge = chargeProjection(c);
  const ticket = { id: c.ticketId, priority: "normal", status: "open", requester_id: c.customerId };
  const obs: Observation[] = [
    {
      id: `obs_charge_${c.n}`,
      world: "planning",
      entity: { vendor: "stripe", kind: "charge", id: c.chargeId },
      projectionVersion: "stripe.charge.v1",
      projection: charge,
      fingerprint: fingerprint(charge),
      capturedAt: CAPTURED_AT,
    },
    {
      id: `obs_ticket_${c.n}`,
      world: "planning",
      entity: { vendor: "zendesk", kind: "ticket", id: c.ticketId },
      projectionVersion: "zendesk.ticket.v1",
      projection: ticket,
      fingerprint: fingerprint(ticket),
      capturedAt: CAPTURED_AT,
    },
  ];
  const projections = { [c.chargeId]: charge };
  const query: QueryObservation = {
    id: `q_charges_${c.n}`,
    world: "planning",
    vendor: "stripe",
    predicate: { kind: "stripe.charges.byCustomerInWindow", customerId: c.customerId, ...WINDOW },
    cutoff: CAPTURED_AT,
    complete: true,
    matchingIds: [c.chargeId],
    projectionVersion: "stripe.charge.v1",
    projections,
    fingerprint: fingerprint({ matchingIds: [c.chargeId], projections }),
    capturedAt: CAPTURED_AT,
  };
  return { obs, query };
}

function actionsFor(c: CaseSpec): Action[] {
  const common = { caseId: `case_${c.n}`, obligationId: `obl_overcharge_${c.n}` };
  return [
    {
      ...common,
      id: `refund_${c.n}`,
      kind: "stripe.refund.create",
      dependsOn: [],
      requiredRole: c.role,
      evidence: [`obs_charge_${c.n}`],
      queryEvidence: [`q_charges_${c.n}`],
      compensation: "compensable_by_new_action",
      protection: "native_guard_with_documented_limits",
      rationale: `Duplicate September charge ${c.chargeId} under incident INC-BILL-0927.`,
      args: {
        chargeId: c.chargeId,
        amount: { amountMinor: c.amountMinor, currency: "cad" },
        reason: "duplicate",
      },
    },
    {
      ...common,
      id: `patch_${c.n}`,
      kind: "zendesk.ticket.patchFields",
      dependsOn: [],
      requiredRole: "support_lead",
      evidence: [`obs_ticket_${c.n}`],
      queryEvidence: [],
      compensation: "conditional_reversible",
      protection: "native_guard_with_documented_limits",
      rationale: "Raise priority while the remedy is in flight.",
      args: { ticketId: c.ticketId, set: { priority: "high" }, before: { priority: "normal" } },
    },
    {
      ...common,
      id: `note_${c.n}`,
      kind: "zendesk.ticket.appendPrivateNote",
      dependsOn: [`refund_${c.n}`],
      requiredRole: "support_lead",
      evidence: [`obs_ticket_${c.n}`],
      queryEvidence: [],
      compensation: "irreversible",
      protection: "no_atomic_guard",
      rationale: "Record the confirmed refund on the ticket.",
      args: {
        ticketId: c.ticketId,
        public: false,
        template: { id: "refund-confirmed", version: 1 },
        bindings: {
          refundId: { $ref: "result", stepId: `refund_${c.n}`, path: "refund.id" },
          amountMinor: c.amountMinor,
        },
      },
    },
  ];
}

export function billingManifest(planId = "plan_fixture"): PlanManifest {
  const parts = CASES.map(observationsFor);
  return {
    schemaVersion: 1,
    orgId: "org_demo",
    incidentId: "INC-BILL-0927",
    planId,
    revision: 1,
    parentRevision: null,
    target: { environment: "operational" },
    versions: {
      planner: {
        model: "fixture",
        promptVersion: "fixture",
        toolSchemaHash: fingerprint("fixture-planner"),
      },
      adapters: { stripe: "0.0.0", zendesk: "0.0.0" },
    },
    policies: [{ id: "billing-remedy", version: 1 }],
    observations: parts.flatMap((p) => p.obs),
    queryObservations: parts.map((p) => p.query),
    actions: CASES.flatMap(actionsFor),
    excluded: [],
  };
}

function allConfirmed(m: PlanManifest): ReplayBundle["expected"] {
  return m.actions.map((a) => ({ actionId: a.id, outcome: "confirmed" as const }));
}

function withOverrides(
  m: PlanManifest,
  overrides: Record<string, ReplayBundle["expected"][number]["outcome"]>,
): ReplayBundle["expected"] {
  return allConfirmed(m).map((e) => ({ ...e, outcome: overrides[e.actionId] ?? e.outcome }));
}

export function happyPathBundle(): ReplayBundle {
  const manifest = billingManifest("plan_happy");
  return {
    schemaVersion: 1,
    id: "happy-path",
    title: "Two customers, nothing changes between approval and apply",
    evidence: "fixture",
    manifest,
    perturbations: [],
    expected: allConfirmed(manifest),
  };
}

/** A new matching charge appears for case_001 after approval: its refund and note are held. */
export function phantomBundle(): ReplayBundle {
  const manifest = billingManifest("plan_phantom");
  return {
    schemaVersion: 1,
    id: "phantom",
    title: "New matching charge appears after approval",
    evidence: "fixture",
    manifest,
    perturbations: [
      {
        kind: "inject_records",
        vendor: "stripe",
        world: "operational",
        at: "before_apply",
        records: {
          charges: [
            {
              id: "ch_fixture_001_dup",
              customer: "cus_fixture_001",
              amount: 4210,
              amount_refunded: 0,
              currency: "cad",
              status: "succeeded",
              created: 1_790_294_400, // 2026-09-25T00:00Z, inside the incident window
            },
          ],
        },
      },
    ],
    expected: withOverrides(manifest, { refund_001: "held", note_001: "skipped_dependency" }),
  };
}

/** The case_001 refund commits but its response is lost; recovery must not refund twice. */
export function unknownOutcomeBundle(): ReplayBundle {
  const manifest = billingManifest("plan_unknown");
  return {
    schemaVersion: 1,
    id: "unknown-outcome",
    title: "Refund commits, response lost, executor restarts",
    evidence: "fixture",
    manifest,
    perturbations: [{ kind: "drop_response_after_commit", stepId: "refund_001" }],
    expected: allConfirmed(manifest),
  };
}

/** A teammate edits case_002's priority, then its note fails: compensation keeps their edit. */
export function teammateConflictBundle(): ReplayBundle {
  const manifest = billingManifest("plan_conflict");
  return {
    schemaVersion: 1,
    id: "teammate-conflict",
    title: "Teammate edit survives compensation",
    evidence: "fixture",
    manifest,
    perturbations: [
      {
        kind: "teammate_field_edit",
        ticketId: "5532",
        field: "priority",
        value: "urgent",
        at: { afterStep: "patch_002" },
      },
      { kind: "fail_step", stepId: "note_002" },
    ],
    expected: withOverrides(manifest, { patch_002: "compensation_conflict", note_002: "rejected" }),
  };
}

export const allBundles = (): ReplayBundle[] => [
  happyPathBundle(),
  phantomBundle(),
  unknownOutcomeBundle(),
  teammateConflictBundle(),
];
