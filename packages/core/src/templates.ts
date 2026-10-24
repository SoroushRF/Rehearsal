import { type Action, OPERATION_MARKER_PREFIX } from "@rehearsal/contracts";
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
  "refund-issued@1": {
    values: { customerName: "name", amountMinor: "minor" },
    render: (v) =>
      `Hi ${v.customerName},\n\nWe've refunded ${formatCad(Number(v.amountMinor))} for the duplicate charge on your account. Sorry for the trouble.`,
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
 * `ZendeskTicketAppendPublicReply`; not in `Action` until T1.13 adds it).
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

/** The approved reply text, after checking it is exactly what its template renders. */
export function replyBodyFor(action: ReplyAction): string {
  const key = `${action.args.template.id}@${action.args.template.version}`;
  const template = REPLY_TEMPLATES[key];
  if (!template) throw new Error(`unknown reply template ${key}`);
  checkReplyValues(key, template, action.args.values);
  if (template.render(action.args.values) !== action.args.body) {
    throw new Error(`reply body doesn't match its approved template ${key}`);
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
