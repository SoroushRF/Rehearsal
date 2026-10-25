import type { Action, Observation, PlanManifest, QueryObservation } from "@rehearsal/contracts";
import { RehearsalScenarioId } from "@rehearsal/contracts";
import { describe, expect, it } from "vitest";
import {
  assertRehearsalChallengeTarget,
  CHALLENGE_CATALOG,
  CHALLENGE_CATALOG_VERSION,
  catalogProblems,
  challengeCatalogDocument,
  challengeOperations,
  challengesDigest,
  injectChargeRecord,
  lookupScenario,
  resolveScenario,
} from "../src/challenges";

const AT = "2026-10-01T12:00:00.000Z";
const WINDOW = { createdGte: "2026-09-01T00:00:00.000Z", createdLt: "2026-10-01T00:00:00.000Z" };
const HEX = "ab".repeat(32);

function chargeObs(n: string, customerId: string, chargeId: string): Observation {
  const projection = {
    id: chargeId,
    customer: customerId,
    amount: 4210,
    amount_refunded: 0,
    currency: "cad",
    status: "succeeded",
  };
  return {
    id: `obs_charge_${n}`,
    world: "planning",
    entity: { vendor: "stripe", kind: "charge", id: chargeId },
    projectionVersion: "stripe.charge.v2",
    projection,
    fingerprint: HEX,
    capturedAt: AT,
  };
}

function ticketObs(n: string, customerId: string, ticketId: string): Observation {
  const projection = { id: ticketId, priority: "normal", status: "open", requester_id: customerId };
  return {
    id: `obs_ticket_${n}`,
    world: "planning",
    entity: { vendor: "zendesk", kind: "ticket", id: ticketId },
    projectionVersion: "zendesk.ticket.v2",
    projection,
    fingerprint: HEX,
    capturedAt: AT,
  };
}

function query(n: string, customerId: string, chargeId: string): QueryObservation {
  const projection = {
    id: chargeId,
    customer: customerId,
    amount: 4210,
    amount_refunded: 0,
    currency: "cad",
    status: "succeeded",
  };
  return {
    id: `q_charges_${n}`,
    world: "planning",
    vendor: "stripe",
    predicate: { kind: "stripe.charges.byCustomerInWindow", customerId, ...WINDOW },
    cutoff: AT,
    complete: true,
    matchingIds: [chargeId],
    projectionVersion: "stripe.charge.v2",
    projections: { [chargeId]: projection },
    fingerprint: HEX,
    capturedAt: AT,
  };
}

function actionsFor(n: string, chargeId: string, ticketId: string): Action[] {
  const common = {
    caseId: `case_${n}`,
    obligationId: `obl_${n}`,
    requiredRole: "support_lead" as const,
    compensation: "compensable_by_new_action" as const,
    protection: "native_guard_with_documented_limits" as const,
    rationale: "test",
  };
  return [
    {
      ...common,
      id: `refund_${n}`,
      kind: "stripe.refund.create",
      dependsOn: [],
      evidence: [`obs_charge_${n}`],
      queryEvidence: [`q_charges_${n}`],
      args: {
        chargeId,
        amount: { amountMinor: 4210, currency: "cad" },
        reason: "duplicate",
      },
    },
    {
      ...common,
      id: `patch_${n}`,
      kind: "zendesk.ticket.patchFields",
      dependsOn: [],
      evidence: [`obs_ticket_${n}`],
      queryEvidence: [],
      compensation: "conditional_reversible",
      args: { ticketId, set: { priority: "high" }, before: { priority: "normal" } },
    },
    {
      ...common,
      id: `note_${n}`,
      kind: "zendesk.ticket.appendPrivateNote",
      dependsOn: [`refund_${n}`],
      evidence: [`obs_ticket_${n}`],
      queryEvidence: [],
      compensation: "irreversible",
      protection: "no_atomic_guard",
      args: {
        ticketId,
        public: false,
        template: { id: "refund-confirmed", version: 1 },
        bindings: {},
      },
    },
  ];
}

function plan(cases = ["001", "002"]): PlanManifest {
  const specs = cases.map((n, i) => ({
    n,
    customerId: `cus_plan_${n}`,
    chargeId: `ch_plan_${n}`,
    ticketId: String(5531 + i),
  }));
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
    observations: specs.flatMap((s) => [
      chargeObs(s.n, s.customerId, s.chargeId),
      ticketObs(s.n, s.customerId, s.ticketId),
    ]),
    queryObservations: specs.map((s) => query(s.n, s.customerId, s.chargeId)),
    actions: specs.flatMap((s) => actionsFor(s.n, s.chargeId, s.ticketId)),
    excluded: [],
  };
}

function resolved(id: RehearsalScenarioId, manifest = plan()) {
  const result = resolveScenario(manifest, { id, version: CHALLENGE_CATALOG_VERSION });
  if (!result.ok) throw new Error(result.reason);
  return result.scenario;
}

describe("challenge catalog (T4.11)", () => {
  it("publishes one current version of every allowlisted scenario and no fault payload", () => {
    expect(catalogProblems(CHALLENGE_CATALOG)).toEqual([]);
    expect(CHALLENGE_CATALOG.map((s) => s.id).sort()).toEqual(
      [...RehearsalScenarioId.options].sort(),
    );
    expect(CHALLENGE_CATALOG.every((s) => s.version === 1 && s.containerWide === false)).toBe(true);
    expect(lookupScenario({ id: "phantom_membership", version: 2 })).toBeUndefined();
    const document = challengeCatalogDocument();
    expect(document.evidence).toBe("fixture");
    expect(JSON.stringify(document)).not.toMatch(/cus_|ch_plan|ch_INC|\/_admin|localhost/);
  });

  it("gives every published version a digest of its definition", () => {
    const clean = lookupScenario({ id: "clean", version: 1 });
    const phantom = lookupScenario({ id: "phantom_membership", version: 1 });
    if (!clean || !phantom) throw new Error("missing scenario");
    expect(challengesDigest(clean)).toBe(challengesDigest(clean));
    expect(challengesDigest(clean)).not.toBe(challengesDigest(phantom));
  });

  it("binds the phantom to the plan's window and holds only that refund and its note", () => {
    const scenario = resolved("phantom_membership");
    const phantom = scenario.challenges.find(
      (c) => c.kind === "inject_charge" && c.role === "phantom",
    );
    const control = scenario.challenges.find(
      (c) => c.kind === "inject_charge" && c.role === "control",
    );
    if (phantom?.kind !== "inject_charge" || control?.kind !== "inject_charge") {
      throw new Error("missing charges");
    }
    const start = Date.parse(WINDOW.createdGte) / 1000;
    const end = Date.parse(WINDOW.createdLt) / 1000;
    expect(phantom.charge.customerId).toBe("cus_plan_001");
    expect(phantom.charge.created).toBeGreaterThanOrEqual(start);
    expect(phantom.charge.created).toBeLessThan(end);
    expect(control.charge.created).toBeGreaterThanOrEqual(end);
    expect(phantom.charge.id).toMatch(/^ch_rhp[0-9a-f]{14}$/);
    expect(control.charge.id).not.toBe(phantom.charge.id);
    expect(phantom.charge.id).not.toBe("ch_plan_001");

    expect(scenario.steps.map((s) => [s.actionId, s.outcome, s.holdKind])).toEqual([
      ["refund_001", "held", "query_membership_changed"],
      ["patch_001", "confirmed", null],
      ["note_001", "skipped_dependency", null],
      ["refund_002", "confirmed", null],
      ["patch_002", "confirmed", null],
      ["note_002", "confirmed", null],
    ]);
    expect(scenario.effects).toContainEqual({
      kind: "refund_count",
      actionId: "refund_001",
      chargeId: "ch_plan_001",
      count: 0,
    });
    expect(scenario.effects).toContainEqual({
      kind: "refund_count",
      actionId: "refund_002",
      chargeId: "ch_plan_002",
      count: 1,
    });
    expect(scenario.effects).toContainEqual({
      kind: "query_membership",
      queryId: "q_charges_001",
      chargeId: control.charge.id,
      member: false,
    });
  });

  it("refuses a phantom the cited window cannot hold, and a plan with no window query", () => {
    const narrow = plan();
    const queryObs = narrow.queryObservations[0];
    if (queryObs?.predicate.kind !== "stripe.charges.byCustomerInWindow") {
      throw new Error("missing query");
    }
    queryObs.predicate.createdLt = "2026-09-02T00:00:00.000Z";
    expect(resolveScenario(narrow, { id: "phantom_membership", version: 1 })).toEqual({
      ok: false,
      reason: "the phantom charge would fall outside the cited window",
    });

    const bare = plan(["001"]);
    bare.actions[0]?.queryEvidence.splice(0);
    expect(resolveScenario(bare, { id: "phantom_membership", version: 1 }).ok).toBe(false);
  });

  it("keeps a benign charge outside the window and confirms every step", () => {
    const scenario = resolved("benign_nonmatching_change");
    expect(scenario.steps.every((s) => s.outcome === "confirmed" && s.holdKind === null)).toBe(
      true,
    );
    const control = scenario.challenges[0];
    if (control?.kind !== "inject_charge") throw new Error("missing control");
    expect(control.role).toBe("control");
    expect(control.charge.created).toBeGreaterThanOrEqual(Date.parse(WINDOW.createdLt) / 1000);
    expect(scenario.effects).toContainEqual(
      expect.objectContaining({
        kind: "query_membership",
        member: false,
        chargeId: control.charge.id,
      }),
    );
  });

  it("edits the patched ticket only after the note is rejected, and refuses a plan that already uses that priority", () => {
    const scenario = resolved("teammate_field_edit");
    expect(scenario.challenges.map((c) => c.kind)).toEqual(["fail_step", "teammate_field_edit"]);
    const edit = scenario.challenges[1];
    if (edit?.kind !== "teammate_field_edit") throw new Error("missing edit");
    expect(edit.when).toEqual({
      afterActionId: "note_001",
      outcome: "rejected",
      before: "compensation",
    });
    expect(edit.ticketId).toBe("5531");
    expect(edit.value).toBe("urgent");
    expect(scenario.effects).toContainEqual({
      kind: "ticket_field",
      actionId: "patch_001",
      ticketId: "5531",
      field: "priority",
      value: "urgent",
    });
    expect(scenario.steps.find((s) => s.actionId === "note_001")?.outcome).toBe("rejected");
    expect(scenario.steps.find((s) => s.actionId === "patch_001")?.outcome).toBe("confirmed");

    const urgent = plan();
    const patch = urgent.actions.find((a) => a.id === "patch_001");
    if (patch?.kind !== "zendesk.ticket.patchFields") throw new Error("missing patch");
    patch.args.set.priority = "urgent";
    expect(resolveScenario(urgent, { id: "teammate_field_edit", version: 1 })).toMatchObject({
      ok: false,
    });
  });

  it("names a dropped refund for the runner to restart, and expects that refund once", () => {
    const scenario = resolved("lost_response_restart");
    expect(scenario.challenges).toEqual([
      {
        kind: "drop_response_after_commit",
        when: "during_run",
        actionId: "refund_001",
        thenRestart: true,
      },
    ]);
    expect(scenario.steps.every((s) => s.outcome === "confirmed")).toBe(true);
    expect(scenario.effects).toContainEqual({
      kind: "refund_count",
      actionId: "refund_001",
      chargeId: "ch_plan_001",
      count: 1,
    });
  });

  it("turns challenges into inject, a timed ticket write, or a named transport mode", () => {
    const phantom = challengeOperations(resolved("phantom_membership"));
    expect(phantom).toEqual([
      expect.objectContaining({ kind: "inject_records", when: "before_run", path: "/inject" }),
    ]);
    const inject = phantom[0];
    if (inject?.kind !== "inject_records") throw new Error("missing inject");
    expect(inject.charges).toHaveLength(2);
    expect(JSON.stringify(phantom)).not.toMatch(/fault|reset/);

    const teammate = challengeOperations(resolved("teammate_field_edit"));
    expect(teammate.map((op) => op.kind)).toEqual(["runner_transport", "vendor_write"]);
    expect(teammate[1]).toMatchObject({
      method: "PUT",
      path: "/api/v2/tickets/5531.json",
      body: { ticket: { priority: "urgent" } },
      when: { afterActionId: "note_001", outcome: "rejected", before: "compensation" },
    });

    const lost = challengeOperations(resolved("lost_response_restart"));
    expect(lost).toEqual([
      {
        kind: "runner_transport",
        when: "during_run",
        mode: "drop_response_after_commit",
        actionId: "refund_001",
        thenRestart: true,
      },
    ]);
    expect(challengeOperations(resolved("clean"))).toEqual([]);
  });

  it("replaces a template's own customer and id when building an inject body", () => {
    const charge = resolved("phantom_membership").challenges[0];
    if (charge?.kind !== "inject_charge") throw new Error("missing charge");
    const record = injectChargeRecord(
      { id: "ch_template", customer: "cus_template", amount: 1, livemode: false },
      charge.charge,
    );
    expect(record.id).toBe(charge.charge.id);
    expect(record.customer).toBe("cus_plan_001");
    expect(record.amount).toBe(4210);
    expect(record.amount_refunded).toBe(0);
    expect(record.created).toBe(charge.charge.created);
    expect(record.livemode).toBe(false);
  });

  it("refuses a challenge aimed at another tenant or a shared endpoint", () => {
    expect(() =>
      assertRehearsalChallengeTarget({
        rehearsalId: "abcd1234",
        tenant: "rh-abcd1234",
        endpoint: "127.0.0.1:8103",
        sharedEndpoints: ["127.0.0.1:8101"],
      }),
    ).not.toThrow();
    expect(() =>
      assertRehearsalChallengeTarget({
        rehearsalId: "abcd1234",
        tenant: "rehearsal-demo",
        endpoint: "127.0.0.1:8103",
        sharedEndpoints: [],
      }),
    ).toThrow(/rh-abcd1234/);
    expect(() =>
      assertRehearsalChallengeTarget({
        rehearsalId: "abcd1234",
        tenant: "rh-abcd1234",
        endpoint: "127.0.0.1:8101",
        sharedEndpoints: ["127.0.0.1:8101"],
      }),
    ).toThrow(/planning or operational/);
  });
});
