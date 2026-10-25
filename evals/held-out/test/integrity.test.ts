import { incidentRecords } from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import { loadSets } from "../src/sets";

// T4.14: every held-out set is well formed, reproducible, and seeds the shapes its kinds promise.

const sets = loadSets();

const unix = (iso: string) => Date.parse(iso) / 1000;

describe("held-out sets", () => {
  it("has at least three", () => {
    expect(sets.map((s) => s.id)).toEqual(["ho1", "ho2", "ho3"]);
  });
});

describe.each(sets)("set $id", (set) => {
  const { incident, records, tasks } = set;
  const gte = unix(incident.window.createdGte);
  const lt = unix(incident.window.createdLt);
  const inWindow = (created: number) => created >= gte && created < lt;
  const charges = new Map(records.stripe.charges.map((c) => [String(c.id), c]));
  const cases = new Map(records.cases.map((c) => [c.key, c]));

  it("generates the same records every time, with unique IDs", () => {
    expect(incidentRecords(incident)).toEqual(records);
    expect(charges.size).toBe(records.stripe.charges.length);
    expect(records.cases.map((c) => c.ticketId)).toEqual(
      records.cases.map((_, i) => incident.ids.ticketBase + i),
    );
    expect(new Set(records.cases.map((c) => c.customerId)).size).toBe(records.cases.length);
    expect(new Set(records.cases.map((c) => c.requesterId)).size).toBe(records.cases.length);
    for (const ch of records.stripe.charges) {
      expect(String(ch.id).startsWith(`ch_${incident.ids.prefix}`)).toBe(true);
    }
  });

  it("covers mixed outcomes: duplicates, at least three kinds of control", () => {
    const kinds = records.cases.map((c) => c.kind);
    expect(kinds.filter((k) => k === "duplicate" || k === "triple").length).toBeGreaterThanOrEqual(
      5,
    );
    expect(new Set(kinds.filter((k) => k.startsWith("control_"))).size).toBeGreaterThanOrEqual(3);
  });

  it("seeds each kind as described", () => {
    for (const c of records.cases) {
      const cs = c.chargeIds.map((id) => charges.get(id) as Record<string, unknown>);
      const created = cs.map((ch) => Number(ch.created));
      expect(cs.every((ch) => ch.customer === c.customerId && ch.currency === c.currency)).toBe(
        true,
      );
      switch (c.kind) {
        case "duplicate":
        case "triple":
        case "control_other_currency":
        case "control_outside_window":
          expect(cs).toHaveLength(c.kind === "triple" ? 3 : 2);
          expect(new Set(cs.map((ch) => ch.invoice)).size).toBe(1);
          expect(cs.every((ch) => ch.amount === c.amountMinor && ch.status === "succeeded")).toBe(
            true,
          );
          break;
        case "control_distinct":
          expect(new Set(cs.map((ch) => ch.invoice)).size).toBe(2);
          expect(new Set(cs.map((ch) => ch.amount)).size).toBe(2);
          break;
        case "control_failed_retry":
          expect(cs.map((ch) => ch.status)).toEqual(["succeeded", "failed"]);
          expect(cs[1]).toMatchObject({ amount_captured: 0, captured: false, paid: false });
          expect(new Set(cs.map((ch) => ch.invoice)).size).toBe(1);
          break;
      }
      if (c.kind === "control_other_currency") expect(c.currency).toBe("usd");
      else expect(c.currency).toBe(set.policy.currency);
      if (c.kind === "control_outside_window") expect(created.some(inWindow)).toBe(false);
      else expect(inWindow(created[0] as number)).toBe(true);
    }
  });

  it("links every ticket to its customer unless the case says otherwise", () => {
    for (const [i, t] of records.zendesk.tickets.entries()) {
      const c = records.cases[i];
      expect(t.external_id).toBe(c?.ticketExternalId ?? c?.customerId);
      expect(t.requester_id).toBe(c?.requesterId);
      expect(t.tags).toEqual(["billing", incident.incident.toLowerCase().replaceAll("-", "_")]);
    }
  });

  it("uses the policy its tasks name", () => {
    expect([set.policy.id, set.policy.version]).toEqual([tasks.policy.id, tasks.policy.version]);
  });

  it("plants setup on charges that exist", () => {
    for (const s of tasks.setup) {
      expect(cases.get(s.caseKey)?.chargeIds[s.charge]).toBeDefined();
    }
  });

  it("refers only to its own cases, with drift where its kind says", () => {
    const ids = new Set<string>(charges.keys());
    for (const task of tasks.tasks) {
      expect(task.id.startsWith(`${set.id.toUpperCase()}-`)).toBe(true);
      if (task.scope !== "all") for (const k of task.scope) expect(cases.has(k)).toBe(true);
      for (const f of task.faults) if ("caseKey" in f) expect(cases.has(f.caseKey)).toBe(true);
      for (const d of task.drift) {
        if ("caseKey" in d) expect(cases.has(d.caseKey)).toBe(true);
        if (!("chargeId" in d)) continue;
        expect(ids.has(d.chargeId)).toBe(false);
        ids.add(d.chargeId);
        const at = unix(d.at);
        if (d.kind === "phantom_charge" || d.kind === "stranger_charge") {
          expect(inWindow(at)).toBe(true);
        }
        if (d.kind === "late_charge") expect(at).toBeGreaterThanOrEqual(lt);
        if (d.kind === "early_charge") expect(at).toBeLessThan(gte);
        if (d.kind === "stranger_charge") {
          expect(records.cases.some((c) => c.customerId === d.customerId)).toBe(false);
        }
      }
      for (const e of task.events) {
        expect(tasks.precedents.map((p) => p.id)).toContain(e.precedentId);
        expect(task.requires).toContain("precedent_registry");
      }
    }
  });
});
