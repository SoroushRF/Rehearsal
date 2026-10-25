import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INCIDENT } from "../src";
import { heldOutIds, loadHeldOutCatalog } from "../src/held-out";

const loaded = loadHeldOutCatalog();
const demoCustomers = new Set(INCIDENT.cases.map((c) => c.customerId));
const demoRequesters = new Set(INCIDENT.cases.map((c) => c.requesterId));

const sources = [
  "../../../packages/planner/src",
  "../../../apps/planner-worker/src",
  "../../../evals/scorecard/src",
].map((dir) => join(import.meta.dirname, dir));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("held-out incidents", () => {
  it("loads three versioned sets, twice the same way", () => {
    expect(loaded.catalog.version).toBe(1);
    expect(loaded.catalog.evidence).toBe("fixture");
    expect(loaded.catalog.authoredBeforePlannerRuns).toBe(true);
    expect(loaded.sets.map((set) => set.id)).toEqual(["a", "b", "c"]);
    expect(loadHeldOutCatalog()).toEqual(loaded);
    for (const set of loaded.sets) {
      expect(set.incident.version).toBe(loaded.catalog.version);
      expect(set.gold.version).toBe(loaded.catalog.version);
      expect(set.gold.evidence).toBe("fixture");
    }
  });

  it("pairs every case with gold and no extra gold", () => {
    for (const set of loaded.sets) {
      expect(Object.keys(set.gold.cases).sort()).toEqual(
        set.incident.cases.map((c) => c.key).sort(),
      );
    }
  });

  it("keeps the three sets and the demo cohort on disjoint ids", () => {
    const seen = {
      incidents: new Set<string>([INCIDENT.incident]),
      customers: new Set(demoCustomers),
      requesters: new Set(demoRequesters),
      charges: new Set<string>(),
      tickets: new Set<number>(),
    };
    for (const set of loaded.sets) {
      const ids = heldOutIds(set);
      expect(seen.incidents.has(ids.incidentId)).toBe(false);
      seen.incidents.add(ids.incidentId);
      for (const id of ids.customers) {
        expect(seen.customers.has(id)).toBe(false);
        seen.customers.add(id);
      }
      for (const id of ids.requesters) {
        expect(seen.requesters.has(id)).toBe(false);
        seen.requesters.add(id);
      }
      for (const id of ids.charges) {
        expect(seen.charges.has(id)).toBe(false);
        seen.charges.add(id);
      }
      for (const id of ids.tickets) {
        expect(id).toBeGreaterThanOrEqual(9_300_000);
        expect(seen.tickets.has(id)).toBe(false);
        seen.tickets.add(id);
      }
    }
  });

  it("uses integer minor units and one failing condition per control", () => {
    for (const set of loaded.sets) {
      const start = Date.parse(set.incident.window.createdGte);
      const end = Date.parse(set.incident.window.createdLt);
      for (const c of set.incident.cases) {
        expect(Number.isInteger(c.amountMinor)).toBe(true);
        expect(c.amountMinor).toBeGreaterThan(0);
        const when = Date.parse(c.chargedAt);
        if (c.kind === "control_outside_window") expect(when < start || when >= end).toBe(true);
        else expect(when >= start && when < end).toBe(true);
        if (c.kind === "control_other_currency") expect(c.currency).toBe("usd");
        else expect(c.currency).toBe("cad");
        if (c.kind === "control_unequal") expect(c.otherAmountMinor).not.toBe(c.amountMinor);
        if (c.kind === "wrong_owner") expect(c.ticketCustomerId).not.toBe(c.customerId);
        if (c.kind === "duplicate") expect(c.otherAmountMinor).toBeUndefined();
      }
    }
  });

  it("covers a credit, a refund, a hold, and a case that must be left alone", () => {
    const decisions = loaded.sets.flatMap((set) => Object.values(set.gold.cases));
    expect(decisions.some((c) => c.decision === "apply_credit")).toBe(true);
    expect(decisions.some((c) => c.decision === "apply_refund")).toBe(true);
    expect(decisions.some((c) => c.decision === "hold")).toBe(true);
    expect(decisions.some((c) => c.decision === "leave")).toBe(true);
    const rules = new Set(decisions.map((c) => c.rule));
    for (const rule of [
      "R4.credit_over_limit",
      "R5.remedy_already_completed",
      "R1.currency",
      "evidence_unavailable",
      "wrong_owner",
      "not_a_duplicate",
      "row_changed",
      "outside_window",
    ]) {
      expect(rules.has(rule)).toBe(true);
    }
  });

  it("names the drift cases the issue asks for, and omits a changed precedent", () => {
    const drifts = loaded.sets.flatMap((set) =>
      set.incident.cases.map((c) => c.drift?.kind).filter((kind) => kind !== undefined),
    );
    expect(drifts).toEqual(
      expect.arrayContaining([
        "late_charge",
        "public_comment",
        "teammate_priority",
        "incomplete_query",
      ]),
    );
    expect(loaded.catalog.omitted.map((item) => item.id)).toEqual(["changed_precedent"]);
  });

  it("is not imported by the planner, the planner worker, or the scorecard", () => {
    const hits = sources.flatMap(sourceFiles).filter((path) => {
      const text = readFileSync(path, "utf8");
      return text.includes("held-out") || text.includes("loadHeldOutCatalog");
    });
    expect(hits).toEqual([]);
  });
});
