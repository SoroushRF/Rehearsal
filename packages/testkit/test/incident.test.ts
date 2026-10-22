import { describe, expect, it } from "vitest";
import { incidentRecords } from "../src";

const records = incidentRecords();
const charges = new Map(records.stripe.charges.map((c) => [c.id as string, c]));
const inWindow = (created: number) =>
  created >= Date.parse("2026-09-01T00:00:00Z") / 1000 &&
  created < Date.parse("2026-10-01T00:00:00Z") / 1000;

describe("seeded incident", () => {
  it("has 5–10 overcharged customers and one of each control", () => {
    const kinds = records.cases.map((c) => c.kind);
    const duplicates = kinds.filter((k) => k === "duplicate").length;
    expect(duplicates).toBeGreaterThanOrEqual(5);
    expect(duplicates).toBeLessThanOrEqual(10);
    for (const k of ["control_distinct", "control_other_currency", "control_outside_window"]) {
      expect(kinds).toContain(k);
    }
  });

  it("is deterministic, with unique ids and one ticket per case", () => {
    expect(incidentRecords()).toEqual(records);
    expect(charges.size).toBe(records.cases.length * 2);
    const tickets = records.zendesk.tickets.map((t) => t.id);
    expect(new Set(tickets).size).toBe(records.cases.length);
    expect(new Set(records.cases.map((c) => c.customerId)).size).toBe(records.cases.length);
  });

  it("makes each duplicate two identical CAD charges in the window, the second 90 s later", () => {
    for (const c of records.cases.filter((c) => c.kind === "duplicate")) {
      const [a, b] = c.chargeIds.map((id) => charges.get(id) as Record<string, number | string>);
      expect(a?.currency).toBe("cad");
      expect(b?.amount).toBe(a?.amount);
      expect(b?.invoice).toBe(a?.invoice);
      expect(Number(b?.created) - Number(a?.created)).toBe(90);
      expect(inWindow(Number(a?.created)) && inWindow(Number(b?.created))).toBe(true);
      expect(Number.isInteger(a?.amount)).toBe(true);
    }
  });

  it("makes each control fail exactly one condition", () => {
    const byKind = (kind: string) => records.cases.find((c) => c.kind === kind);
    const [d1, d2] = byKind("control_distinct")?.chargeIds.map((id) => charges.get(id)) ?? [];
    expect(d1?.invoice).not.toBe(d2?.invoice);
    expect(d1?.amount).not.toBe(d2?.amount);
    expect(charges.get(byKind("control_other_currency")?.chargeIds[0] ?? "")?.currency).toBe("usd");
    const outside = charges.get(byKind("control_outside_window")?.chargeIds[1] ?? "");
    expect(inWindow(Number(outside?.created))).toBe(false);
  });

  it("keeps every template field, since Stripe inject fills in nothing", () => {
    const template = records.stripe.charges[0] as Record<string, unknown>;
    for (const c of records.stripe.charges) expect(Object.keys(c)).toEqual(Object.keys(template));
    const ticket = records.zendesk.tickets[0] as Record<string, unknown>;
    expect(ticket.external_id).toBe(records.cases[0]?.customerId);
    expect(ticket.raw_subject).toBe(ticket.subject);
  });
});
