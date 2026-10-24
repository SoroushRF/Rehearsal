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

const SUMMARY_TEMPLATES: Record<string, (v: Readonly<Record<string, string | number>>) => string> =
  {
    "run-summary@1": (v) =>
      `Billing remediation ${v.incidentId}: ${v.refunded} refund(s) issued, ${v.held} step(s) held for review.`,
  };

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
  const values: Record<string, string | number> = {};
  for (const [name, b] of Object.entries(action.args.bindings)) {
    const value = typeof b === "object" ? resolved.get(summaryCountKey(name)) : b;
    if (value === undefined) throw new Error(`unresolved summary count ${name}`);
    if (typeof b === "object" && !(Number.isInteger(value) && Number(value) >= 0)) {
      throw new TypeError(`summary count ${name} must be a non-negative integer, got ${value}`);
    }
    values[name] = value;
  }
  const key = `${action.args.template.id}@${action.args.template.version}`;
  const render = SUMMARY_TEMPLATES[key];
  if (!render) throw new Error(`unknown summary template ${key}`);
  return `${render(values)}\n\n${operationMarker(operationKey)}`;
}
