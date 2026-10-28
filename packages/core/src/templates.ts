import { type Action, OPERATION_MARKER_PREFIX, type OutcomeCount } from "@rehearsal/contracts";
import { bindingKey } from "./bindings";
import type { ResolvedBindings } from "./ports";

/**
 * Private-note templates. Notes are rendered only from an approved template plus literals and
 * bindings to confirmed receipts, never from model text. Each note carries an operation marker so
 * reconciliation can find it by reading the ticket's comments.
 */
const TEMPLATES: Record<string, (v: Readonly<Record<string, string | number>>) => string> = {
  "refund-confirmed@1": (v) =>
    `Refund ${v.refundId} for ${formatCad(Number(v.amountMinor))} has been issued for the duplicate charge.`,
  "credit-confirmed@1": (v) =>
    `A credit of ${formatCad(Number(v.amountMinor))} has been added to the customer's invoice balance for the duplicate charge.`,
  // Live demo (#331): a support backlog follow-up. It states only what the plan itself did.
  "backlog-followup@1": () =>
    "Flagged in a support backlog review: this ticket was waiting for a first reply.",
};

function formatCad(minor: number): string {
  if (!Number.isInteger(minor)) throw new TypeError(`amountMinor must be an integer, got ${minor}`);
  return `${(minor / 100).toFixed(2)} CAD`;
}

export function operationMarker(operationKey: string): string {
  return `${OPERATION_MARKER_PREFIX}${operationKey}]`;
}

export function renderNote(
  template: { id: string; version: number },
  values: Readonly<Record<string, string | number>>,
  operationKey: string,
): string {
  const render = TEMPLATES[`${template.id}@${template.version}`];
  if (!render) throw new Error(`unknown note template ${template.id}@${template.version}`);
  return `${render(values)}\n\n${operationMarker(operationKey)}`;
}

/** The exact note text for an appendPrivateNote action, with bindings from confirmed receipts. */
export function noteBodyFor(
  action: Extract<Action, { kind: "zendesk.ticket.appendPrivateNote" }>,
  bindings: ResolvedBindings,
  operationKey: string,
): string {
  const values: Record<string, string | number> = {};
  for (const [name, b] of Object.entries(action.args.bindings)) {
    const value = typeof b === "object" ? bindings.get(bindingKey(b)) : b;
    if (value === undefined) throw new Error(`unresolved binding ${name}`);
    values[name] = value;
  }
  return renderNote(action.args.template, values, operationKey);
}

/**
 * Public customer replies (T3.11). The plan carries the rendered `body` with its template and
 * values; each value is checked against what the template declares, the body is rendered again
 * and must match byte for byte, so only approved template text with checked values reaches a
 * customer. The operation marker follows the body.
 */
/** One reply template: the values it takes (each checked) and its text. */
interface ReplyTemplate {
  /** `name` → a short single-line text; `minor` → a positive integer amount in minor units. */
  values: Readonly<Record<string, "name" | "minor">>;
  render: (v: Readonly<Record<string, string | number>>) => string;
}

const REPLY_TEMPLATES: Record<string, ReplyTemplate> = {
  "credit-issued@1": {
    values: { customerName: "name", amountMinor: "minor" },
    render: (v) =>
      `Hi ${v.customerName},\n\nWe've added ${formatCad(Number(v.amountMinor))} to your invoice balance for the duplicate charge on your account. This credit will go toward future invoices. Sorry for the trouble.`,
  },
  "refund-issued@1": {
    values: { customerName: "name", amountMinor: "minor" },
    render: (v) =>
      `Hi ${v.customerName},\n\nWe've refunded ${formatCad(Number(v.amountMinor))} for the duplicate charge on your account. Sorry for the trouble.`,
  },
  "backlog-followup@1": {
    values: { customerName: "name" },
    render: (v) =>
      `Hi ${v.customerName},\n\nSorry for the wait. Someone on our support team is now on your ticket and will follow up here.`,
  },
};

const MAX_NAME_CHARS = 80;

/** Each value is exactly what its template declares, so a value can't add text of its own. */
function checkReplyValues(
  key: string,
  template: ReplyTemplate,
  values: Record<string, string | number>,
) {
  const expected = Object.keys(template.values).sort();
  const given = Object.keys(values).sort();
  if (expected.join("\0") !== given.join("\0")) {
    throw new Error(`reply ${key} takes exactly ${expected.join(", ")}; got ${given.join(", ")}`);
  }
  for (const [name, type] of Object.entries(template.values)) {
    const v = values[name];
    if (type === "minor" && !(typeof v === "number" && Number.isInteger(v) && v > 0)) {
      throw new TypeError(`reply value ${name} must be a positive integer amount`);
    }
    if (type === "name") {
      if (typeof v !== "string" || v.trim().length === 0 || v.length > MAX_NAME_CHARS) {
        throw new TypeError(`reply value ${name} must be a short non-empty name`);
      }
      if (/[\r\n]/.test(v) || v.includes(OPERATION_MARKER_PREFIX)) {
        throw new TypeError(`reply value ${name} must be one line without an operation marker`);
      }
    }
  }
}

/**
 * What sending needs of a `zendesk.ticket.appendPublicReply` action (contracts'
 * `ZendeskTicketAppendPublicReply`).
 */
export interface ReplyAction {
  id: string;
  kind: "zendesk.ticket.appendPublicReply";
  args: {
    ticketId: string;
    public: true;
    template: { id: string; version: number };
    values: Record<string, string | number>;
    body: string;
  };
}

/** A reply template rendered with checked values: the text a planner puts in `body` (T1.13). */
export function renderReply(
  ref: ReplyAction["args"]["template"],
  values: Record<string, string | number>,
): string {
  const key = `${ref.id}@${ref.version}`;
  const template = REPLY_TEMPLATES[key];
  if (!template) throw new Error(`unknown reply template ${key}`);
  checkReplyValues(key, template, values);
  return template.render(values);
}

/** The approved reply text, after checking it is exactly what its template renders. */
export function replyBodyFor(action: ReplyAction): string {
  const { template } = action.args;
  if (renderReply(template, action.args.values) !== action.args.body) {
    throw new Error(
      `reply body doesn't match its approved template ${template.id}@${template.version}`,
    );
  }
  if (action.args.body.includes(OPERATION_MARKER_PREFIX)) {
    throw new Error("reply body must not contain an operation marker");
  }
  return action.args.body;
}

/** The exact comment a public reply sends: the approved body, then the operation marker. */
export function replyCommentFor(action: ReplyAction, operationKey: string): string {
  return `${replyBodyFor(action)}\n\n${operationMarker(operationKey)}`;
}

/**
 * Run-summary templates for `slack.message.postSummary` (T3.10). Like notes: an approved template
 * plus literals and counts of approved steps' outcomes, never model text, and the operation marker
 * so an uncertain post is found by reading the channel.
 */
/**
 * What rendering and posting need of a `slack.message.postSummary` action (contracts'
 * `SlackMessagePostSummary`; not in `Action` until T1.7 adds it).
 */
export interface SummaryAction {
  id: string;
  kind: "slack.message.postSummary";
  args: {
    channelId: string;
    template: { id: string; version: number };
    bindings: Record<string, string | number | OutcomeCount>;
  };
}

/** One summary template: which bindings it takes, which must be outcome counts, and its text. */
interface SummaryTemplate {
  /** Literal bindings: short single-line plan text, never a count. */
  literals: readonly string[];
  /** Bindings that must be counts of approved steps' outcomes (never a literal number). */
  counts: readonly string[];
  render: (v: Readonly<Record<string, string | number>>) => string;
}

const SUMMARY_TEMPLATES: Record<string, SummaryTemplate> = {
  "credit-summary@1": {
    literals: ["incidentId"],
    counts: ["credited", "held"],
    render: (v) =>
      `Billing remediation ${v.incidentId}: 0 refund(s) issued, ${v.credited} balance credit(s) issued, ${v.held} step(s) held for review.`,
  },
  "run-summary@2": {
    literals: ["incidentId"],
    counts: ["refunded", "credited", "held"],
    render: (v) =>
      `Billing remediation ${v.incidentId}: ${v.refunded} refund(s) issued, ${v.credited} balance credit(s) issued, ${v.held} step(s) held for review.`,
  },
  "run-summary@1": {
    literals: ["incidentId"],
    counts: ["refunded", "held"],
    render: (v) =>
      `Billing remediation ${v.incidentId}: ${v.refunded} refund(s) issued, ${v.held} step(s) held for review.`,
  },
  "backlog-summary@1": {
    literals: ["incidentId"],
    counts: ["followedUp", "held"],
    render: (v) =>
      `Support backlog ${v.incidentId}: ${v.followedUp} ticket(s) followed up, ${v.held} step(s) held for review.`,
  },
};

/** Slack stores at most 40,000 characters of `text`; the marker comes last, so stay under it. */
export const MAX_SUMMARY_CHARS = 39_000;
const MAX_LITERAL_CHARS = 200;

/** Where the executor puts an outcome count's value among the resolved bindings. */
export function summaryCountKey(name: string): string {
  return `summary-count:${name}`;
}

/**
 * The exact Slack text for a postSummary action. Literal bindings are used as approved; each
 * outcome count must already be resolved (by the executor, from settled receipts) under
 * {@link summaryCountKey}.
 */
export function summaryTextFor(
  action: SummaryAction,
  resolved: ResolvedBindings,
  operationKey: string,
): string {
  const key = `${action.args.template.id}@${action.args.template.version}`;
  const template = SUMMARY_TEMPLATES[key];
  if (!template) throw new Error(`unknown summary template ${key}`);
  const expected = [...template.literals, ...template.counts].sort();
  const given = Object.keys(action.args.bindings).sort();
  if (expected.join("\0") !== given.join("\0")) {
    throw new Error(`summary ${key} takes exactly ${expected.join(", ")}; got ${given.join(", ")}`);
  }
  const values: Record<string, string | number> = {};
  for (const name of template.literals) {
    const b = action.args.bindings[name];
    if (typeof b !== "string" || b.trim().length === 0 || b.length > MAX_LITERAL_CHARS) {
      throw new TypeError(`summary literal ${name} must be a short non-empty string`);
    }
    if (/[\r\n]/.test(b) || b.includes(OPERATION_MARKER_PREFIX)) {
      throw new TypeError(`summary literal ${name} must be one line without an operation marker`);
    }
    values[name] = b;
  }
  for (const name of template.counts) {
    if (typeof action.args.bindings[name] !== "object") {
      throw new TypeError(`summary ${name} must be a count of approved steps' outcomes`);
    }
    const value = resolved.get(summaryCountKey(name));
    if (value === undefined) throw new Error(`unresolved summary count ${name}`);
    if (!(typeof value === "number" && Number.isInteger(value) && value >= 0)) {
      throw new TypeError(`summary count ${name} must be a non-negative integer, got ${value}`);
    }
    values[name] = value;
  }
  const text = `${template.render(values)}\n\n${operationMarker(operationKey)}`;
  if (text.length > MAX_SUMMARY_CHARS) {
    throw new Error(`summary is ${text.length} characters; Slack would cut the marker off`);
  }
  return text;
}
