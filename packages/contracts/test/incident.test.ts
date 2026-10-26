import { describe, expect, it } from "vitest";
import { CompanySnapshot, CreateProblem, IncidentDraft, StoredIncident } from "../src";

const draft = {
  kind: "service_outage",
  title: "Checkout outage",
  description: "Checkout was down for two hours; credit the affected customers.",
  window: { createdGte: "2026-10-01T00:00:00.000Z", createdLt: "2026-10-25T00:00:00.000Z" },
};

describe("live demo incidents", () => {
  it("accepts a draft of each kind and refuses an unknown kind", () => {
    for (const kind of ["duplicate_charge", "service_outage", "support_backlog"]) {
      expect(IncidentDraft.safeParse({ ...draft, kind }).success).toBe(true);
    }
    expect(IncidentDraft.safeParse({ ...draft, kind: "delete_everything" }).success).toBe(false);
  });

  it("binds a stored incident to an org and an ID the rehearse route takes", () => {
    const stored = {
      ...draft,
      incidentId: "INC-OUTAGE-0001",
      orgId: "org_1",
      createdAt: draft.window.createdLt,
    };
    expect(StoredIncident.safeParse(stored).success).toBe(true);
    expect(StoredIncident.safeParse({ ...stored, incidentId: "../admin" }).success).toBe(false);
  });

  it("caps problem seeding", () => {
    expect(CreateProblem.safeParse({ preset: "duplicate_charge", count: 3 }).success).toBe(true);
    expect(CreateProblem.safeParse({ preset: "duplicate_charge", count: 50 }).success).toBe(false);
  });

  it("keeps company money in integer minor units", () => {
    const snapshot = {
      asOf: draft.window.createdLt,
      charges: [
        {
          id: "ch_1",
          customer: "cus_1",
          invoice: null,
          amountMinor: 4999,
          currency: "cad",
          created: draft.window.createdGte,
          refundedMinor: 0,
        },
      ],
      customers: [{ id: "cus_1", email: null, balanceMinor: -500 }],
      tickets: [],
      slack: [],
      changed: { ch_1: "run_1" },
    };
    expect(CompanySnapshot.safeParse(snapshot).success).toBe(true);
    snapshot.charges[0] = {
      ...snapshot.charges[0],
      amountMinor: 49.99,
    } as (typeof snapshot.charges)[0];
    expect(CompanySnapshot.safeParse(snapshot).success).toBe(false);
  });
});
