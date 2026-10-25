import type {
  Action,
  Observation,
  PlanManifest,
  QueryObservation,
  RehearsalScenarioId,
} from "@rehearsal/contracts";
import { describe, expect, it } from "vitest";
import { CHALLENGE_CATALOG_VERSION, resolveScenario } from "../src/challenges";
import { operationKey } from "../src/executor";
import { planHash } from "../src/hash";
import { rehearsalOperationKey, snapshotDigest } from "../src/rehearsal";
import { operationMarker, replyBodyFor } from "../src/templates";
import {
  type RefundView,
  type RehearsalJudgment,
  VERIFIER_VERSION,
  type VerifierReads,
  verifyRehearsal,
} from "../src/verifier";

const AT = "2026-10-01T12:00:00.000Z";
const WINDOW = { createdGte: "2026-09-01T00:00:00.000Z", createdLt: "2026-10-01T00:00:00.000Z" };
const HEX = "ab".repeat(32);
const REHEARSAL = "abcd1234";

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
      args: { chargeId, amount: { amountMinor: 4210, currency: "cad" }, reason: "duplicate" },
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

function plan(): PlanManifest {
  const specs = ["001", "002"].map((n, i) => ({
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

const manifest = plan();

function emptyReads(): VerifierReads {
  return { refunds: {}, queries: {}, tickets: {}, comments: {}, credits: {}, slack: {} };
}

function marker(m: PlanManifest, action: Action): string {
  return operationMarker(rehearsalOperationKey(REHEARSAL, operationKey(m.orgId, m.planId, action)));
}

function refundOf(
  action: Extract<Action, { kind: "stripe.refund.create" }>,
  id: string,
): RefundView {
  return {
    id,
    amountMinor: action.args.amount.amountMinor,
    currency: action.args.amount.currency,
    status: "succeeded",
    chargeId: action.args.chargeId,
  };
}

/** A world in which every step of `m` landed once, as the clean scenario expects. */
function confirmedReads(m: PlanManifest): VerifierReads {
  const reads = emptyReads();
  for (const action of m.actions) {
    if (action.kind === "stripe.refund.create") {
      reads.refunds[action.args.chargeId] = {
        ok: true,
        value: { complete: true, refunds: [refundOf(action, `re_${action.id}`)] },
      };
    } else if (action.kind === "zendesk.ticket.patchFields") {
      reads.tickets[action.args.ticketId] = {
        ok: true,
        value: { priority: action.args.set.priority ?? "high", status: "open" },
      };
    } else if (action.kind === "zendesk.ticket.appendPrivateNote") {
      reads.comments[action.args.ticketId] = {
        ok: true,
        value: {
          complete: true,
          comments: [{ public: false, body: `noted\n\n${marker(m, action)}` }],
        },
      };
    }
  }
  return reads;
}

function judge(
  id: RehearsalScenarioId,
  reads: VerifierReads,
  outcomes: Record<string, "confirmed" | "held" | "rejected" | "skipped_dependency"> = {},
  m: PlanManifest = manifest,
): RehearsalJudgment {
  return verifyRehearsal({
    manifest: m,
    rehearsalId: REHEARSAL,
    planHash: planHash(m),
    snapshotDigest: snapshotDigest(m),
    verifierVersion: VERIFIER_VERSION,
    scenario: { id, version: CHALLENGE_CATALOG_VERSION },
    results: m.actions.map((action) => ({
      actionId: action.id,
      outcome: outcomes[action.id] ?? "confirmed",
    })),
    reads,
  });
}

function at(judgment: RehearsalJudgment, actionId: string) {
  const found = judgment.steps.find((step) => step.actionId === actionId);
  if (!found) throw new Error(`no ${actionId}`);
  return found.verification;
}

describe("rehearsal verifier (T4.12)", () => {
  it("passes the clean scenario when each effect is present once", () => {
    const judgment = judge("clean", confirmedReads(manifest));
    expect(judgment.verdict).toBe("passed");
    expect(judgment.steps.every((step) => step.verification.status === "matched")).toBe(true);
    expect(at(judgment, "refund_001").detail).toBe("one refund of 4210 cad on ch_plan_001");
  });

  it("fails a confirmed receipt when the charge was not refunded", () => {
    const reads = confirmedReads(manifest);
    reads.refunds.ch_plan_001 = { ok: true, value: { complete: true, refunds: [] } };
    const judgment = judge("clean", reads);
    expect(judgment.verdict).toBe("failed");
    expect(at(judgment, "refund_001")).toEqual({
      status: "mismatched",
      detail: "missing effect; the receipt says confirmed",
    });
    expect(at(judgment, "refund_002").status).toBe("matched");
  });

  it("calls a hold wrongful when the scenario expected the effect and the world does not have it", () => {
    const reads = confirmedReads(manifest);
    reads.refunds.ch_plan_001 = { ok: true, value: { complete: true, refunds: [] } };
    const judgment = judge("clean", reads, { refund_001: "held" });
    expect(at(judgment, "refund_001").status).toBe("mismatched");
    expect(at(judgment, "refund_001").detail).toContain("wrongful hold");
    expect(at(judgment, "refund_001").detail).toContain("receipt says held");
  });

  it("counts two refunds of the approved amount as a duplicate", () => {
    const reads = confirmedReads(manifest);
    const action = manifest.actions.find((item) => item.id === "refund_001");
    if (action?.kind !== "stripe.refund.create") throw new Error("refund");
    reads.refunds.ch_plan_001 = {
      ok: true,
      value: { complete: true, refunds: [refundOf(action, "re_a"), refundOf(action, "re_b")] },
    };
    const judgment = judge("clean", reads);
    expect(at(judgment, "refund_001").status).toBe("mismatched");
    expect(at(judgment, "refund_001").detail).toContain("duplicate effect: 2 refunds");
  });

  it("does not treat an unfinished refund list as absence", () => {
    const reads = confirmedReads(manifest);
    reads.refunds.ch_plan_001 = { ok: true, value: { complete: false, refunds: [] } };
    const judgment = judge("clean", reads);
    expect(judgment.verdict).toBe("unknown");
    expect(at(judgment, "refund_001").status).toBe("unverified");
    expect(at(judgment, "refund_001").detail).toContain("not proof the effect is absent");
    expect(judgment.limitations).toEqual(["an independent read could not establish every step"]);
  });

  it("leaves a failed read unverified", () => {
    const reads = confirmedReads(manifest);
    reads.refunds.ch_plan_001 = { ok: false, detail: "GET /v1/refunds → 500" };
    const judgment = judge("clean", reads);
    expect(judgment.verdict).toBe("unknown");
    expect(at(judgment, "refund_001")).toEqual({
      status: "unverified",
      detail: "GET /v1/refunds → 500",
    });
  });

  it("matches a phantom hold only when the extra charge is in the query and the refund did not land", () => {
    const bound = resolveScenario(manifest, {
      id: "phantom_membership",
      version: CHALLENGE_CATALOG_VERSION,
    });
    if (!bound.ok) throw new Error(bound.reason);
    const phantom = bound.scenario.effects.find(
      (effect) => effect.kind === "query_membership" && effect.member,
    );
    const control = bound.scenario.effects.find(
      (effect) => effect.kind === "query_membership" && !effect.member,
    );
    if (phantom?.kind !== "query_membership" || control?.kind !== "query_membership") {
      throw new Error("missing membership");
    }
    const reads = confirmedReads(manifest);
    reads.refunds.ch_plan_001 = { ok: true, value: { complete: true, refunds: [] } };
    reads.comments["5531"] = { ok: true, value: { complete: true, comments: [] } };
    reads.queries[phantom.queryId] = {
      ok: true,
      value: { complete: true, matchingIds: ["ch_plan_001", phantom.chargeId] },
    };
    const judgment = judge("phantom_membership", reads, {
      refund_001: "held",
      note_001: "skipped_dependency",
    });
    expect(judgment.verdict).toBe("passed");
    expect(at(judgment, "refund_001").detail).toContain("held:");
    expect(at(judgment, "note_001").detail).toContain("skipped:");

    reads.queries[phantom.queryId] = { ok: true, value: { complete: false, matchingIds: [] } };
    const unfinished = judge("phantom_membership", reads, {
      refund_001: "held",
      note_001: "skipped_dependency",
    });
    expect(unfinished.verdict).toBe("unknown");
    expect(at(unfinished, "refund_001").status).toBe("unverified");
    expect(at(unfinished, "refund_001").detail).toContain("not proof");

    reads.queries[phantom.queryId] = {
      ok: true,
      value: { complete: true, matchingIds: ["ch_plan_001", phantom.chargeId, control.chargeId] },
    };
    const controlInWindow = judge("phantom_membership", reads, {
      refund_001: "held",
      note_001: "skipped_dependency",
    });
    expect(at(controlInWindow, "refund_001").status).toBe("mismatched");
    expect(at(controlInWindow, "refund_001").detail).toContain(control.chargeId);
  });

  it("fails the benign control when its outside-window charge is in the query", () => {
    const bound = resolveScenario(manifest, {
      id: "benign_nonmatching_change",
      version: CHALLENGE_CATALOG_VERSION,
    });
    if (!bound.ok) throw new Error(bound.reason);
    const control = bound.scenario.effects.find((effect) => effect.kind === "query_membership");
    if (control?.kind !== "query_membership") throw new Error("missing control");
    const reads = confirmedReads(manifest);
    reads.queries[control.queryId] = {
      ok: true,
      value: { complete: true, matchingIds: ["ch_plan_001"] },
    };
    expect(judge("benign_nonmatching_change", reads).verdict).toBe("passed");
    reads.queries[control.queryId] = {
      ok: true,
      value: { complete: true, matchingIds: ["ch_plan_001", control.chargeId] },
    };
    const judgment = judge("benign_nonmatching_change", reads);
    expect(judgment.verdict).toBe("failed");
    expect(at(judgment, "refund_001").detail).toContain("is a member");
  });

  it("reads the teammate's priority, not the priority the plan set", () => {
    const reads = confirmedReads(manifest);
    reads.tickets["5531"] = { ok: true, value: { priority: "urgent", status: "open" } };
    reads.comments["5531"] = { ok: true, value: { complete: true, comments: [] } };
    const judgment = judge("teammate_field_edit", reads, { note_001: "rejected" });
    expect(judgment.verdict).toBe("passed");
    expect(at(judgment, "patch_001").detail).toBe("priority is urgent");
    expect(at(judgment, "note_001").detail).toContain("rejected:");

    reads.tickets["5531"] = { ok: true, value: { priority: "high", status: "open" } };
    const restored = judge("teammate_field_edit", reads, { note_001: "rejected" });
    expect(restored.verdict).toBe("failed");
    expect(at(restored, "patch_001").status).toBe("mismatched");
    expect(at(restored, "patch_001").detail).toContain("urgent");
  });

  it("matches one read-back refund for a lost response and rejects a second", () => {
    expect(judge("lost_response_restart", confirmedReads(manifest)).verdict).toBe("passed");
    const reads = confirmedReads(manifest);
    const action = manifest.actions.find((item) => item.id === "refund_001");
    if (action?.kind !== "stripe.refund.create") throw new Error("refund");
    reads.refunds.ch_plan_001 = {
      ok: true,
      value: {
        complete: true,
        refunds: [refundOf(action, "re_a"), { ...refundOf(action, "re_b"), amountMinor: 100 }],
      },
    };
    const wrong = judge("lost_response_restart", reads);
    expect(at(wrong, "refund_001").status).toBe("mismatched");
    expect(at(wrong, "refund_001").detail).toContain("wrong effect");
  });

  it("stays unverified when the plan hash or the verifier version is not the one being judged", () => {
    const reads = confirmedReads(manifest);
    const base = {
      manifest,
      rehearsalId: REHEARSAL,
      planHash: planHash(manifest),
      snapshotDigest: snapshotDigest(manifest),
      verifierVersion: VERIFIER_VERSION,
      scenario: { id: "clean" as const, version: CHALLENGE_CATALOG_VERSION },
      results: manifest.actions.map((action) => ({
        actionId: action.id,
        outcome: "confirmed" as const,
      })),
      reads,
    };
    expect(verifyRehearsal({ ...base, planHash: HEX }).verdict).toBe("unknown");
    expect(verifyRehearsal({ ...base, planHash: HEX }).steps[0]?.verification.status).toBe(
      "unverified",
    );
    expect(verifyRehearsal({ ...base, verifierVersion: "none" }).verdict).toBe("unknown");
  });

  it("verifies a credit, a public reply and a slack summary from their own reads", () => {
    const reply = replyAction();
    const credit = creditAction();
    const summary = summaryAction();
    const m: PlanManifest = { ...manifest, actions: [credit, reply, summary] };
    const reads = emptyReads();
    reads.credits[credit.args.customerId] = {
      ok: true,
      value: {
        complete: true,
        credits: [
          {
            id: "cbtxn_1",
            amountMinor: -credit.args.amount.amountMinor,
            currency: "cad",
            type: "adjustment",
            chargeId: credit.args.chargeId,
          },
        ],
      },
    };
    reads.comments[reply.args.ticketId] = {
      ok: true,
      value: {
        complete: true,
        comments: [{ public: true, body: `${replyBodyFor(reply)}\n\n${marker(m, reply)}` }],
      },
    };
    reads.slack[summary.args.channelId] = {
      ok: true,
      value: { complete: true, texts: [`Billing remediation.\n\n${marker(m, summary)}`] },
    };
    expect(judge("clean", reads, {}, m).verdict).toBe("passed");

    reads.credits[credit.args.customerId] = { ok: true, value: { complete: true, credits: [] } };
    const missing = judge("clean", reads, {}, m);
    expect(at(missing, "credit_001")).toEqual({
      status: "mismatched",
      detail: "missing effect; the receipt says confirmed",
    });

    reads.credits[credit.args.customerId] = {
      ok: true,
      value: {
        complete: true,
        credits: [
          {
            id: "cbtxn_1",
            amountMinor: -credit.args.amount.amountMinor,
            currency: "cad",
            type: "adjustment",
            chargeId: credit.args.chargeId,
          },
          {
            id: "cbtxn_2",
            amountMinor: -100,
            currency: "cad",
            type: "adjustment",
            chargeId: credit.args.chargeId,
          },
        ],
      },
    };
    const extra = judge("clean", reads, {}, m);
    expect(at(extra, "credit_001").status).toBe("mismatched");
    expect(at(extra, "credit_001").detail).toContain("wrong effect");
  });
});

function creditAction(): Extract<Action, { kind: "stripe.customer.balanceCredit" }> {
  return {
    id: "credit_001",
    caseId: "case_001",
    obligationId: "obl_001",
    dependsOn: [],
    requiredRole: "support_lead",
    evidence: ["obs_charge_001"],
    queryEvidence: [],
    compensation: "compensable_by_new_action",
    protection: "best_effort_reread",
    rationale: "test",
    kind: "stripe.customer.balanceCredit",
    args: {
      customerId: "cus_plan_001",
      chargeId: "ch_plan_001",
      amount: { amountMinor: 4210, currency: "cad" },
    },
  };
}

function replyAction(): Extract<Action, { kind: "zendesk.ticket.appendPublicReply" }> {
  const body =
    "Hi Ada,\n\nWe've refunded 42.10 CAD for the duplicate charge on your account. Sorry for the trouble.";
  return {
    id: "reply_001",
    caseId: "case_001",
    obligationId: "obl_001",
    dependsOn: [],
    requiredRole: "support_lead",
    evidence: ["obs_ticket_001"],
    queryEvidence: [],
    compensation: "irreversible",
    protection: "no_atomic_guard",
    rationale: "test",
    kind: "zendesk.ticket.appendPublicReply",
    args: {
      ticketId: "5531",
      public: true,
      template: { id: "refund-issued", version: 1 },
      values: { customerName: "Ada", amountMinor: 4210 },
      body,
    },
  };
}

function summaryAction(): Extract<Action, { kind: "slack.message.postSummary" }> {
  return {
    id: "summary_001",
    caseId: "case_001",
    obligationId: "obl_001",
    dependsOn: ["refund_001"],
    requiredRole: "support_lead",
    evidence: [],
    queryEvidence: [],
    compensation: "irreversible",
    protection: "no_atomic_guard",
    rationale: "test",
    kind: "slack.message.postSummary",
    args: {
      channelId: "C_BILLING",
      template: { id: "run-summary", version: 1 },
      bindings: {
        incidentId: "inc_test",
        refunded: { $count: "outcomes", stepIds: ["refund_001"], outcomes: ["confirmed"] },
        held: { $count: "outcomes", stepIds: ["refund_001"], outcomes: ["held"] },
      },
    },
  };
}
