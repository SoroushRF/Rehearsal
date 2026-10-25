import { readFileSync } from "node:fs";

/**
 * T4.14 held-out incidents and their gold. Not exported from the package index: planner, planner
 * worker, and scorecard code must not import this module. The gold was written with the incidents,
 * before any planner run. Evidence is `fixture` until a run against Era is recorded separately.
 */

const ROOT = new URL("../../../scenarios/billing/held-out/", import.meta.url);
const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, ROOT), "utf8")) as unknown;

export type HeldOutKind =
  | "duplicate"
  | "control_distinct"
  | "control_other_currency"
  | "control_outside_window"
  | "control_unequal"
  | "wrong_owner";

export interface HeldOutCase {
  key: string;
  kind: HeldOutKind;
  customerId: string;
  /** Ticket `external_id` when it is not the charge customer. */
  ticketCustomerId?: string;
  name: string;
  email: string;
  requesterId: number;
  amountMinor: number;
  otherAmountMinor?: number;
  currency: "cad" | "usd";
  chargedAt: string;
  requestedRemedy?: "refund" | "credit";
  prior?:
    | { kind: "balance_credit"; amountMinor: number; currency: "cad" | "usd"; charge: "duplicate" }
    | { kind: "refund"; amountMinor: number; charge: "duplicate" };
  drift?:
    | { kind: "late_charge" }
    | { kind: "public_comment" }
    | { kind: "teammate_priority"; priority: "urgent" }
    | { kind: "incomplete_query" };
}

export interface HeldOutIncident {
  id: string;
  version: number;
  summary: string;
  window: { createdGte: string; createdLt: string };
  idPrefix: string;
  ticketBase: number;
  policy: { id: string; version: number };
  cases: HeldOutCase[];
}

export interface HeldOutGoldCase {
  decision: "apply_refund" | "apply_credit" | "hold" | "leave";
  rule: string | null;
  role: "support_lead" | "finance_lead" | null;
  refunds: number;
  credits: number;
  notes: number;
  priority: "low" | "normal" | "high" | "urgent" | null;
  because: string;
}

export interface HeldOutGold {
  version: number;
  evidence: "fixture";
  cases: Record<string, HeldOutGoldCase>;
}

export interface HeldOutCatalog {
  version: number;
  evidence: "fixture";
  authoredBeforePlannerRuns: true;
  omitted: { id: string; reason: string }[];
  sets: string[];
}

export interface HeldOutSet {
  id: string;
  incident: HeldOutIncident;
  gold: HeldOutGold;
}

export interface HeldOutIds {
  incidentId: string;
  customers: string[];
  requesters: number[];
  charges: string[];
  tickets: number[];
}

export function loadHeldOutCatalog(): { catalog: HeldOutCatalog; sets: HeldOutSet[] } {
  const catalog = readJson("catalog.json") as HeldOutCatalog;
  const sets = catalog.sets.map((id) => ({
    id,
    incident: readJson(`${id}/incident.json`) as HeldOutIncident,
    gold: readJson(`${id}/gold.json`) as HeldOutGold,
  }));
  return { catalog, sets };
}

/** Ids a set would inject. Stable, and disjoint from the demo cohort by construction. */
export function heldOutIds(set: HeldOutSet): HeldOutIds {
  const customers = new Set<string>();
  const charges: string[] = [];
  const tickets: number[] = [];
  const requesters: number[] = [];
  set.incident.cases.forEach((c, index) => {
    customers.add(c.customerId);
    if (c.ticketCustomerId) customers.add(c.ticketCustomerId);
    requesters.push(c.requesterId);
    tickets.push(set.incident.ticketBase + index);
    charges.push(`ch_${set.incident.idPrefix}${c.key}a`, `ch_${set.incident.idPrefix}${c.key}b`);
  });
  return {
    incidentId: set.incident.id,
    customers: [...customers],
    requesters,
    charges,
    tickets,
  };
}
