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
 *   triple                  three identical charges for one invoice, 90 s apart → two excess charges
 *   control_failed_retry    a paid charge and a declined retry of it → nothing to refund
 *
 * The held-out sets (T4.14, evals/held-out) reuse this generator with their own ID prefix and
 * ticket range, so their records look like the cohort's without sharing an ID with it.
 */

const SCENARIO = new URL("../../../scenarios/billing/", import.meta.url);
const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, SCENARIO), "utf8"));

export type IncidentCaseKind =
  | "duplicate"
  | "triple"
  | "control_distinct"
  | "control_other_currency"
  | "control_outside_window"
  | "control_failed_retry";

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
  /** The currency of the customer's Stripe balance, when it isn't the charges' currency. */
  billingCurrency?: "cad" | "usd";
  /** The ticket's `external_id` when it names another customer: the ticket isn't verifiably theirs. */
  ticketExternalId?: string;
}

export interface IncidentSpec {
  incident: string;
  summary: string;
  window: { createdGte: string; createdLt: string };
  /** Charge ID prefix and first ticket ID. INC-BILL-0927 uses `INC0927` and 9100001. */
  ids?: { prefix: string; ticketBase: number };
  cases: IncidentCase[];
}

export const INCIDENT: IncidentSpec = readJson("incident.v1.json");

export interface SeededCase extends IncidentCase {
  /** Charge IDs in creation order. For a duplicate, the second is the one to refund. A triple has three. */
  chargeIds: [string, string, ...string[]];
  invoices: [string, string, ...string[]];
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

const DEFAULT_IDS = { prefix: "INC0927", ticketBase: 9_100_001 };

function seeded(c: IncidentCase, index: number, ids = DEFAULT_IDS): SeededCase {
  const base = `${ids.prefix}${c.key}`;
  const letters = c.kind === "triple" ? ["a", "b", "c"] : ["a", "b"];
  const distinct = c.kind === "control_distinct";
  return {
    ...c,
    chargeIds: letters.map((l) => `ch_${base}${l}`) as SeededCase["chargeIds"],
    invoices: letters.map((l) =>
      distinct ? `in_${base}${l}` : `in_${base}`,
    ) as SeededCase["invoices"],
    ticketId: ids.ticketBase + index,
  };
}

function charge(
  template: Record<string, unknown>,
  c: SeededCase,
  n: number,
): Record<string, unknown> {
  const id = c.chargeIds[n] as string;
  const suffix = id.slice(3);
  const distinct = c.kind === "control_distinct";
  // A retry every 90 s for a duplicate; a separate invoice five days later for the control.
  const created = unix(c.chargedAt) + (distinct ? n * 5 * 86_400 : n * 90);
  const amount = distinct && n === 1 ? c.amountMinor + 1100 : c.amountMinor;
  const billing = template.billing_details as Record<string, unknown>;
  const declined = c.kind === "control_failed_retry" && n === 1;
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
    // The retry was declined: nothing was captured, so there is nothing to refund.
    ...(declined && {
      amount_captured: 0,
      balance_transaction: null,
      captured: false,
      paid: false,
      status: "failed",
      failure_code: "card_declined",
      failure_message: "Your card was declined.",
      outcome: {
        ...(template.outcome as Record<string, unknown>),
        network_status: "declined_by_network",
        reason: "generic_decline",
        seller_message: "The bank did not return any further details with this decline.",
        type: "issuer_declined",
      },
    }),
  };
}

const MONTH = new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" });

function complaint(c: SeededCase): [subject: string, body: string] {
  const date = c.chargedAt.slice(0, 10);
  const charged = money(c.amountMinor, c.currency);
  const us = `Our Stripe customer ID is ${c.customerId}.`;
  switch (c.kind) {
    case "control_distinct":
      return [
        "Two charges this month?",
        `Hi, we see two charges in ${MONTH.format(Date.parse(c.chargedAt))}, for invoices ${c.invoices[0]} and ${c.invoices[1]}. Can you confirm both are correct? ${us}`,
      ];
    case "triple":
      return [
        `Charged three times for invoice ${c.invoices[0]}`,
        `Hi, we were charged ${charged} three times for invoice ${c.invoices[0]} on ${date}. Please refund the extra charges. ${us}`,
      ];
    case "control_failed_retry":
      return [
        `Charged twice for invoice ${c.invoices[0]}?`,
        `Hi, our statement shows two payments of ${charged} for invoice ${c.invoices[0]} on ${date}. Were we charged twice? ${us}`,
      ];
    default:
      return [
        `Charged twice for invoice ${c.invoices[0]}`,
        `Hi, we were charged ${charged} twice for invoice ${c.invoices[0]} on ${date}. Please refund the duplicate. ${us}`,
      ];
  }
}

function ticket(
  template: Record<string, unknown>,
  c: SeededCase,
  tag: string,
): Record<string, unknown> {
  const [subject, body] = complaint(c);
  const opened = new Date(Date.parse(c.chargedAt) + 86_400_000).toISOString().replace(".000", "");
  return {
    ...template,
    id: c.ticketId,
    url: `https://northwind.zendesk.com/api/v2/tickets/${c.ticketId}.json`,
    external_id: c.ticketExternalId ?? c.customerId,
    subject,
    raw_subject: subject,
    description: body,
    status: "open",
    priority: "normal",
    type: "problem",
    requester_id: c.requesterId,
    submitter_id: c.requesterId,
    organization_id: null,
    tags: ["billing", tag],
    created_at: opened,
    updated_at: opened,
    generated_timestamp: unix(opened),
    comments: [{ body, public: true }],
  };
}

/** Fresh copies of the verbatim inject templates in scenarios/billing/fixtures. */
export function fixtureTemplates(): {
  charge: Record<string, unknown>;
  ticket: Record<string, unknown>;
} {
  return {
    charge: readJson("fixtures/stripe.charge.json"),
    ticket: readJson("fixtures/zendesk.ticket.json").ticket,
  };
}

export function incidentRecords(spec: IncidentSpec = INCIDENT): IncidentRecords {
  const { charge: chargeTemplate, ticket: ticketTemplate } = fixtureTemplates();
  const cases = spec.cases.map((c, i) => seeded(c, i, spec.ids));
  const tag = spec.incident.toLowerCase().replaceAll("-", "_");
  return {
    cases,
    stripe: {
      charges: cases.flatMap((c) => c.chargeIds.map((_, n) => charge(chargeTemplate, c, n))),
    },
    zendesk: { tickets: cases.map((c) => ticket(ticketTemplate, c, tag)) },
  };
}

/**
 * The incident's Stripe customers, each billed in its own currency. Era serves an unknown customer
 * as 404, and a balance credit checks the customer's currency first (T1.14). `seedIncident` doesn't
 * inject these, so the cohort's own seed is unchanged.
 */
export function incidentCustomers(spec: IncidentSpec = INCIDENT): Record<string, unknown>[] {
  return spec.cases.map((c) => ({
    id: c.customerId,
    object: "customer",
    currency: c.billingCurrency ?? c.currency,
    balance: 0,
    email: c.email,
    name: c.name,
    metadata: {},
    livemode: false,
    created: Date.parse(spec.window.createdGte) / 1000 - 86_400 * 30,
  }));
}
