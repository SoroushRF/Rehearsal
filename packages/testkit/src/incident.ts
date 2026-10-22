import { readFileSync } from "node:fs";

/**
 * The seeded billing incident (T1.2): Era inject records built from scenarios/billing/incident.v1.json
 * and the verbatim GET templates in scenarios/billing/fixtures. Pure and deterministic, so both
 * worlds get byte-identical records on every reset.
 *
 * Kinds:
 *   duplicate               two identical CAD charges for one invoice, 90 s apart → refund the second
 *   control_distinct        two CAD charges for two different invoices → nothing to refund
 *   control_other_currency  a USD duplicate → the CAD-only policy must hold it
 *   control_outside_window  a CAD duplicate in August → outside the incident predicate
 */

const SCENARIO = new URL("../../../scenarios/billing/", import.meta.url);
const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, SCENARIO), "utf8"));

export type IncidentCaseKind =
  | "duplicate"
  | "control_distinct"
  | "control_other_currency"
  | "control_outside_window";

export interface IncidentCase {
  key: string;
  kind: IncidentCaseKind;
  customerId: string;
  name: string;
  email: string;
  requesterId: number;
  amountMinor: number;
  currency: "cad" | "usd";
  chargedAt: string;
}

export interface IncidentSpec {
  incident: string;
  summary: string;
  window: { createdGte: string; createdLt: string };
  cases: IncidentCase[];
}

export const INCIDENT: IncidentSpec = readJson("incident.v1.json");

export interface SeededCase extends IncidentCase {
  /** Charge IDs in creation order. For a duplicate, the second is the one to refund. */
  chargeIds: [string, string];
  invoices: [string, string];
  ticketId: number;
}

export interface IncidentRecords {
  cases: SeededCase[];
  /** Bodies for POST /_admin/tenants/{T}/inject. */
  stripe: { charges: Record<string, unknown>[] };
  zendesk: { tickets: Record<string, unknown>[] };
}

const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const money = (minor: number, currency: string) =>
  `${(minor / 100).toFixed(2)} ${currency.toUpperCase()}`;

function seeded(c: IncidentCase, index: number): SeededCase {
  const base = `INC0927${c.key}`;
  const distinct = c.kind === "control_distinct";
  return {
    ...c,
    chargeIds: [`ch_${base}a`, `ch_${base}b`],
    invoices: distinct ? [`in_${base}a`, `in_${base}b`] : [`in_${base}`, `in_${base}`],
    ticketId: 9_100_001 + index,
  };
}

function charge(
  template: Record<string, unknown>,
  c: SeededCase,
  n: 0 | 1,
): Record<string, unknown> {
  const id = c.chargeIds[n];
  const suffix = id.slice(3);
  const distinct = c.kind === "control_distinct";
  // A retry 90 s later for a duplicate; a separate invoice five days later for the control.
  const created = unix(c.chargedAt) + (n === 0 ? 0 : distinct ? 5 * 86_400 : 90);
  const amount = distinct && n === 1 ? c.amountMinor + 1100 : c.amountMinor;
  const billing = template.billing_details as Record<string, unknown>;
  return {
    ...template,
    id,
    amount,
    amount_captured: amount,
    amount_refunded: 0,
    refunded: false,
    currency: c.currency,
    customer: c.customerId,
    created,
    description: `Invoice ${c.invoices[n]}`,
    invoice: c.invoices[n],
    payment_intent: `pi_${suffix}`,
    balance_transaction: `txn_${suffix}`,
    billing_details: { ...billing, email: c.email, name: c.name },
    receipt_email: c.email,
    receipt_url: `https://pay.stripe.com/receipts/sim/${id}`,
    metadata: {},
    refunds: { object: "list", data: [], has_more: false, url: `/v1/charges/${id}/refunds` },
  };
}

function ticket(template: Record<string, unknown>, c: SeededCase): Record<string, unknown> {
  const date = c.chargedAt.slice(0, 10);
  const [subject, body] =
    c.kind === "control_distinct"
      ? [
          "Two charges this month?",
          `Hi, we see two charges in September, for invoices ${c.invoices[0]} and ${c.invoices[1]}. Can you confirm both are correct? Our Stripe customer ID is ${c.customerId}.`,
        ]
      : [
          `Charged twice for invoice ${c.invoices[0]}`,
          `Hi, we were charged ${money(c.amountMinor, c.currency)} twice for invoice ${c.invoices[0]} on ${date}. Please refund the duplicate. Our Stripe customer ID is ${c.customerId}.`,
        ];
  const opened = new Date(Date.parse(c.chargedAt) + 86_400_000).toISOString().replace(".000", "");
  return {
    ...template,
    id: c.ticketId,
    url: `https://northwind.zendesk.com/api/v2/tickets/${c.ticketId}.json`,
    external_id: c.customerId,
    subject,
    raw_subject: subject,
    description: body,
    status: "open",
    priority: "normal",
    type: "problem",
    requester_id: c.requesterId,
    submitter_id: c.requesterId,
    organization_id: null,
    tags: ["billing", "inc_bill_0927"],
    created_at: opened,
    updated_at: opened,
    generated_timestamp: unix(opened),
    comments: [{ body, public: true }],
  };
}

export function incidentRecords(spec: IncidentSpec = INCIDENT): IncidentRecords {
  const chargeTemplate = readJson("fixtures/stripe.charge.json");
  const ticketTemplate = readJson("fixtures/zendesk.ticket.json").ticket;
  const cases = spec.cases.map(seeded);
  return {
    cases,
    stripe: {
      charges: cases.flatMap((c) => [charge(chargeTemplate, c, 0), charge(chargeTemplate, c, 1)]),
    },
    zendesk: { tickets: cases.map((c) => ticket(ticketTemplate, c)) },
  };
}
