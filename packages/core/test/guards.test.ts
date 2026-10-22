import type { Action, Observation, QueryObservation, Receipt } from "@rehearsal/contracts";
import { describe, expect, it } from "vitest";
import {
  advanceOverlay,
  compareObservation,
  diffQueryMembership,
  emptyOverlay,
  type GuardVerdict,
  guardAction,
} from "../src/guards";
import { note, patch, refund } from "./fixture";

const AT = "2026-10-01T12:00:00.000Z";
const NOW = "2026-10-21T16:00:00.000Z";
const HASH = "ab".repeat(32);

function holdReason(verdict: GuardVerdict) {
  if (verdict.decision !== "hold") throw new Error(`expected hold, got ${verdict.decision}`);
  return verdict.reason;
}

const chargeProjection = {
  id: "ch_1",
  customer: "cus_1",
  amount: 4210,
  amount_refunded: 0,
  currency: "cad",
  status: "succeeded",
};

const ticketProjection = { id: "1", priority: "normal", status: "open", requester_id: "cus_1" };

const plannedCharge: Observation = {
  id: "obs_charge_1",
  world: "planning",
  entity: { vendor: "stripe", kind: "charge", id: "ch_1" },
  projectionVersion: "stripe.charge.v1",
  projection: chargeProjection,
  fingerprint: HASH,
  capturedAt: AT,
};

const plannedTicket: Observation = {
  id: "obs_ticket_1",
  world: "planning",
  entity: { vendor: "zendesk", kind: "ticket", id: "1" },
  projectionVersion: "zendesk.ticket.v1",
  projection: ticketProjection,
  fingerprint: HASH,
  capturedAt: AT,
};

function reread(observation: Observation, projection: Record<string, unknown>): Observation {
  return {
    ...observation,
    id: `${observation.id}_now`,
    world: "operational",
    projection,
    capturedAt: NOW,
  };
}

const predicate = {
  kind: "stripe.charges.byCustomerInWindow" as const,
  customerId: "cus_1",
  createdGte: "2026-09-01T00:00:00.000Z",
  createdLt: "2026-10-01T00:00:00.000Z",
};

function query(matchingIds: string[], overrides: Partial<QueryObservation> = {}): QueryObservation {
  return {
    id: "q_charges_1",
    world: "planning",
    vendor: "stripe",
    predicate,
    cutoff: AT,
    complete: true,
    matchingIds,
    projectionVersion: "stripe.charge.v1",
    projections: {},
    fingerprint: HASH,
    capturedAt: AT,
    ...overrides,
  };
}

const guardedRefund: Action = {
  ...refund,
  evidence: ["obs_charge_1"],
  queryEvidence: ["q_charges_1"],
};
const guardedPatch: Action = { ...patch, evidence: ["obs_ticket_1"] };
const guardedNote: Action = { ...note, evidence: ["obs_ticket_1"] };
const observations = [plannedCharge, plannedTicket];

function receipt(
  action: Action,
  outcome: Receipt["outcome"],
  observedEffect: Record<string, unknown> = {},
): Receipt {
  return {
    id: `rcpt_${action.id}`,
    actionId: action.id,
    planHash: HASH,
    approvalId: "appr_1",
    outcome,
    providerRef: null,
    observedEffect,
    protection: action.protection,
    holdReason: null,
    limitations: [],
    recordedAt: NOW,
  };
}

describe("compareObservation", () => {
  it("admits an unchanged projection and ignores fields outside it", () => {
    const current = reread(plannedCharge, { ...chargeProjection, updated_at: 1 });
    expect(compareObservation(plannedCharge, current)).toEqual({ decision: "admit" });
  });

  it("holds and names a projected field that changed", () => {
    const current = reread(plannedCharge, { ...chargeProjection, amount_refunded: 4210 });
    expect(compareObservation(plannedCharge, current)).toEqual({
      decision: "hold",
      reason: { kind: "row_changed", observationId: "obs_charge_1", fields: ["amount_refunded"] },
    });
  });

  it("holds when the re-read drops a projected field", () => {
    const { amount_refunded: _dropped, ...rest } = chargeProjection;
    expect(holdReason(compareObservation(plannedCharge, reread(plannedCharge, rest)))).toEqual({
      kind: "row_changed",
      observationId: "obs_charge_1",
      fields: ["amount_refunded"],
    });
  });

  it("holds when the projection version or the record differs", () => {
    const current = reread(plannedCharge, chargeProjection);
    expect(
      holdReason(compareObservation(plannedCharge, { ...current, projectionVersion: "v2" })),
    ).toMatchObject({ kind: "evidence_unavailable", detail: "projection version differs" });
    expect(
      holdReason(
        compareObservation(plannedCharge, {
          ...current,
          entity: { vendor: "stripe", kind: "charge", id: "ch_other" },
        }),
      ),
    ).toMatchObject({ kind: "evidence_unavailable", detail: "re-read is a different record" });
  });

  it("compares against the overlay instead of the planned value", () => {
    const overlay = { byEntity: { "stripe:charge:ch_1": { amount_refunded: 4210 } } };
    const ours = reread(plannedCharge, { ...chargeProjection, amount_refunded: 4210 });
    expect(compareObservation(plannedCharge, ours, overlay)).toEqual({ decision: "admit" });
    const drifted = reread(plannedCharge, { ...chargeProjection, amount_refunded: 9999 });
    expect(holdReason(compareObservation(plannedCharge, drifted, overlay))).toMatchObject({
      kind: "row_changed",
      fields: ["amount_refunded"],
    });
  });
});

describe("diffQueryMembership", () => {
  it("treats an empty match as evidence and ignores order and duplicates", () => {
    expect(diffQueryMembership(query([]), query([]))).toEqual({ decision: "admit" });
    expect(diffQueryMembership(query(["b", "a", "a"]), query(["a", "b"]))).toEqual({
      decision: "admit",
    });
  });

  it("reports an added id when the old rows are unchanged", () => {
    expect(diffQueryMembership(query(["ch_1"]), query(["ch_1", "ch_new"]))).toEqual({
      decision: "hold",
      reason: {
        kind: "query_membership_changed",
        queryObservationId: "q_charges_1",
        added: ["ch_new"],
        removed: [],
      },
    });
  });

  it("reports a removed id, including a query that is now empty", () => {
    expect(holdReason(diffQueryMembership(query(["ch_1"]), query([])))).toEqual({
      kind: "query_membership_changed",
      queryObservationId: "q_charges_1",
      added: [],
      removed: ["ch_1"],
    });
  });

  it("holds an incomplete enumeration even when the ids seen so far match", () => {
    const planned = query(["ch_1"]);
    expect(holdReason(diffQueryMembership({ ...planned, complete: false }, planned))).toEqual({
      kind: "evidence_unavailable",
      evidenceId: "q_charges_1",
      detail: "planned query enumeration is incomplete",
    });
    expect(holdReason(diffQueryMembership(planned, { ...planned, complete: false }))).toEqual({
      kind: "evidence_unavailable",
      evidenceId: "q_charges_1",
      detail: "current query enumeration is incomplete",
    });
  });

  it("holds a re-query that is not the approved predicate", () => {
    const current = query(["ch_1"], { predicate: { ...predicate, customerId: "cus_other" } });
    expect(holdReason(diffQueryMembership(query(["ch_1"]), current))).toMatchObject({
      kind: "evidence_unavailable",
      detail: "predicate differs from the approved query",
    });
  });
});

describe("advanceOverlay", () => {
  it("advances a charge only from a confirmed refund receipt", () => {
    const confirmed = advanceOverlay(
      emptyOverlay(),
      guardedRefund,
      receipt(guardedRefund, "confirmed", { amount_refunded: 4210 }),
      observations,
    );
    expect(confirmed.byEntity["stripe:charge:ch_1"]).toEqual({
      amount_refunded: 4210,
      refunded: true,
    });

    for (const outcome of [
      "rejected",
      "held",
      "unknown_outcome",
      "skipped_dependency",
      "compensated",
      "compensation_conflict",
    ] as const) {
      expect(
        advanceOverlay(
          emptyOverlay(),
          guardedRefund,
          receipt(guardedRefund, outcome),
          observations,
        ),
      ).toEqual(emptyOverlay());
    }
  });

  it("ignores a receipt for a different action", () => {
    expect(
      advanceOverlay(
        emptyOverlay(),
        guardedRefund,
        receipt(guardedPatch, "confirmed"),
        observations,
      ),
    ).toEqual(emptyOverlay());
  });

  it("does not adopt a read-back that contradicts the approved write", () => {
    expect(
      advanceOverlay(
        emptyOverlay(),
        guardedPatch,
        receipt(guardedPatch, "confirmed", { priority: "urgent" }),
        observations,
      ),
    ).toEqual(emptyOverlay());
  });

  it("lets the note admit after our own confirmed priority patch", () => {
    const overlay = advanceOverlay(
      emptyOverlay(),
      guardedPatch,
      receipt(guardedPatch, "confirmed", { priority: "high" }),
      observations,
    );
    const input = {
      action: guardedNote,
      plannedObservations: observations,
      currentObservations: [reread(plannedTicket, { ...ticketProjection, priority: "high" })],
      plannedQueries: [],
      currentQueries: [],
    };
    expect(guardAction({ ...input, overlay })).toEqual({ decision: "admit" });
    expect(holdReason(guardAction(input))).toMatchObject({
      kind: "row_changed",
      fields: ["priority"],
    });
  });

  it("still holds a collateral change after our own refund", () => {
    const overlay = advanceOverlay(
      emptyOverlay(),
      guardedRefund,
      receipt(guardedRefund, "confirmed"),
      observations,
    );
    const current = reread(plannedCharge, {
      ...chargeProjection,
      amount_refunded: 4210,
      status: "failed",
    });
    expect(holdReason(compareObservation(plannedCharge, current, overlay))).toMatchObject({
      kind: "row_changed",
      fields: ["status"],
    });
  });

  it("credits our write on every planned observation of the same record", () => {
    const overlay = advanceOverlay(
      emptyOverlay(),
      guardedRefund,
      receipt(guardedRefund, "confirmed"),
      observations,
    );
    const otherSnapshot: Observation = { ...plannedCharge, id: "obs_charge_1_again" };
    const current = reread(otherSnapshot, { ...chargeProjection, amount_refunded: 4210 });
    expect(compareObservation(otherSnapshot, current, overlay)).toEqual({ decision: "admit" });
  });

  it("expects `refunded` to flip only when our refunds cover the whole charge", () => {
    const tracked: Observation = {
      ...plannedCharge,
      projection: { ...chargeProjection, refunded: false },
    };
    const full = advanceOverlay(
      emptyOverlay(),
      guardedRefund,
      receipt(guardedRefund, "confirmed"),
      [tracked],
    );
    const fullyRefunded = { ...chargeProjection, amount_refunded: 4210, refunded: true };
    expect(compareObservation(tracked, reread(tracked, fullyRefunded), full)).toEqual({
      decision: "admit",
    });

    const smaller: Action = {
      ...guardedRefund,
      args: { ...refund.args, amount: { amountMinor: 1000, currency: "cad" } },
    } as Action;
    const partial = advanceOverlay(emptyOverlay(), smaller, receipt(smaller, "confirmed"), [
      tracked,
    ]);
    const partlyRefunded = { ...chargeProjection, amount_refunded: 1000, refunded: false };
    expect(compareObservation(tracked, reread(tracked, partlyRefunded), partial)).toEqual({
      decision: "admit",
    });
  });

  it("takes `updated_at` from our patch and note responses, and still holds a later edit", () => {
    const stamped: Observation = {
      ...plannedTicket,
      projection: { ...ticketProjection, updated_at: "2026-10-01T12:00:00Z" },
    };
    const afterPatch = advanceOverlay(
      emptyOverlay(),
      guardedPatch,
      receipt(guardedPatch, "confirmed", { priority: "high", updated_at: "2026-10-21T16:00:01Z" }),
      [stamped],
    );
    const afterNote = advanceOverlay(
      afterPatch,
      guardedNote,
      receipt(guardedNote, "confirmed", { updated_at: "2026-10-21T16:00:02Z" }),
      [stamped],
    );
    const ours = { ...ticketProjection, priority: "high", updated_at: "2026-10-21T16:00:02Z" };
    expect(compareObservation(stamped, reread(stamped, ours), afterNote)).toEqual({
      decision: "admit",
    });

    const teammate = { ...ours, updated_at: "2026-10-21T16:00:05Z" };
    expect(holdReason(compareObservation(stamped, reread(stamped, teammate), afterNote))).toEqual({
      kind: "row_changed",
      observationId: "obs_ticket_1",
      fields: ["updated_at"],
    });
  });
});

describe("guardAction", () => {
  const plannedQuery = query(["ch_1"]);
  const base = {
    action: guardedRefund,
    plannedObservations: observations,
    currentObservations: [reread(plannedCharge, chargeProjection)],
    plannedQueries: [plannedQuery],
    currentQueries: [plannedQuery],
  };

  it("admits when every row and query still matches", () => {
    expect(guardAction(base)).toEqual({ decision: "admit" });
  });

  it("holds when the re-read or the re-query is missing", () => {
    expect(holdReason(guardAction({ ...base, currentObservations: [] }))).toMatchObject({
      kind: "evidence_unavailable",
      detail: "re-read is missing",
    });
    expect(holdReason(guardAction({ ...base, currentQueries: [] }))).toMatchObject({
      kind: "evidence_unavailable",
      detail: "query was not re-run",
    });
  });

  it("holds when two re-reads claim the same record", () => {
    const current = reread(plannedCharge, chargeProjection);
    expect(
      holdReason(
        guardAction({ ...base, currentObservations: [current, { ...current, id: "dup" }] }),
      ),
    ).toMatchObject({ kind: "evidence_unavailable", detail: "more than one re-check matches" });
  });

  it("holds when the plan names evidence it does not contain", () => {
    expect(holdReason(guardAction({ ...base, plannedObservations: [] }))).toEqual({
      kind: "evidence_unavailable",
      evidenceId: "obs_charge_1",
      detail: "approved evidence is missing from the plan",
    });
  });
});
