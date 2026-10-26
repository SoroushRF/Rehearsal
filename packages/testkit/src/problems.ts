import { readFileSync } from "node:fs";
import type { IncidentKind } from "@rehearsal/contracts";
import { fixtureTemplates, INCIDENT, type IncidentCase, incidentRecords } from "./incident";

/**
 * Live demo (#331): the records a "create a problem" request injects, from the presets in
 * scenarios/incidents. Every ID carries the request's stamp, so a second request adds new records
 * instead of colliding with the first (Era's inject doesn't dedupe by ID).
 */

const PRESETS = new URL("../../../scenarios/incidents/", import.meta.url);

interface DuplicatePreset {
  preset: "duplicate_charge";
  customers: string[];
  amountMinor: number;
  currency: "cad";
  chargedAt: string;
}

interface BacklogPreset {
  preset: "support_backlog";
  customers: string[];
  openedAt: string;
  subject: string;
  body: string;
}

export interface ProblemRecords {
  stripe: { charges: Record<string, unknown>[] };
  zendesk: { tickets: Record<string, unknown>[] };
}

/** The kinds with a preset. `service_outage` has no typed remedy, so nothing to cause. */
export const PROBLEM_PRESETS: readonly IncidentKind[] = ["duplicate_charge", "support_backlog"];

function preset<T>(kind: IncidentKind): T {
  return JSON.parse(readFileSync(new URL(`${kind}.json`, PRESETS), "utf8")) as T;
}

function rosterCases(keys: string[], count: number): IncidentCase[] {
  return keys.slice(0, count).map((key) => {
    const found = INCIDENT.cases.find((c) => c.key === key);
    if (!found) throw new Error(`the roster has no customer ${key}`);
    return found;
  });
}

/**
 * Records for `count` roster customers, or undefined for a kind without a preset. `stamp` is
 * letters and digits; `ticketBase` is the first new ticket ID.
 */
export function problemRecords(
  kind: IncidentKind,
  count: number,
  stamp: string,
  ticketBase: number,
): ProblemRecords | undefined {
  if (!/^[A-Za-z0-9]+$/.test(stamp)) throw new Error("stamp must be letters and digits");
  if (kind === "duplicate_charge") {
    const p = preset<DuplicatePreset>(kind);
    const at = Date.parse(p.chargedAt);
    const cases = rosterCases(p.customers, count).map((c, i) => ({
      ...c,
      kind: "duplicate" as const,
      amountMinor: p.amountMinor,
      currency: p.currency,
      chargedAt: new Date(at + i * 3_600_000).toISOString(),
    }));
    const records = incidentRecords({
      ...INCIDENT,
      incident: `PROBLEM-${stamp}`,
      ids: { prefix: `P${stamp}`, ticketBase },
      cases,
    });
    // The customers' own tickets already name them; only the charges are new.
    return { stripe: records.stripe, zendesk: { tickets: [] } };
  }
  if (kind === "support_backlog") {
    const p = preset<BacklogPreset>(kind);
    const at = Date.parse(p.openedAt);
    const { ticket: template } = fixtureTemplates();
    const tickets = rosterCases(p.customers, count).map((c, i) => {
      const id = ticketBase + i;
      const opened = new Date(at + i * 3_600_000).toISOString().replace(".000", "");
      return {
        ...template,
        id,
        url: `https://northwind.zendesk.com/api/v2/tickets/${id}.json`,
        external_id: c.customerId,
        subject: p.subject,
        raw_subject: p.subject,
        description: p.body,
        status: "new",
        priority: "normal",
        type: "question",
        requester_id: c.requesterId,
        submitter_id: c.requesterId,
        assignee_id: null,
        organization_id: null,
        tags: ["support", "backlog"],
        created_at: opened,
        updated_at: opened,
        generated_timestamp: Date.parse(opened) / 1000,
        comments: [{ body: p.body, public: true }],
      };
    });
    return { stripe: { charges: [] }, zendesk: { tickets } };
  }
  return undefined;
}
