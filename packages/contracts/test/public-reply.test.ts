import { describe, expect, it } from "vitest";
import { Action, OPERATION_MARKER_PREFIX, ZendeskTicketAppendPublicReply } from "../src";

const reply = {
  id: "step_reply_1",
  caseId: "case_1",
  obligationId: "obl_1",
  dependsOn: ["step_refund_1"],
  requiredRole: "support_lead",
  evidence: ["obs_ticket_1"],
  queryEvidence: [],
  compensation: "irreversible",
  protection: "no_atomic_guard",
  rationale: "Tell the customer the duplicate charge was refunded.",
  kind: "zendesk.ticket.appendPublicReply",
  args: {
    ticketId: "4000000",
    public: true,
    template: { id: "refund-reply", version: 1 },
    values: { firstName: "Ana", amountMinor: 4210 },
    body: "Hi Ana,\n\nWe've refunded 42.10 CAD for the duplicate charge.",
  },
};

const parse = (args: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
  ZendeskTicketAppendPublicReply.safeParse({
    ...reply,
    ...overrides,
    args: { ...reply.args, ...args },
  });

describe("zendesk.ticket.appendPublicReply (T1.18)", () => {
  it("parses a public reply whose exact text is in the action", () => {
    expect(ZendeskTicketAppendPublicReply.parse(reply).args.body).toBe(reply.args.body);
  });

  it("keeps the body byte for byte, so the hash covers exactly what is sent", () => {
    const body = "  Hi Ana —\n\n42.10 CAD.  \n";
    expect(parse({ body }).data?.args.body).toBe(body);
  });

  it("refuses a blank body", () => {
    expect(parse({ body: "" }).success).toBe(false);
    expect(parse({ body: " \n\t" }).success).toBe(false);
  });

  it("refuses a body that carries an operation marker, which only the executor adds", () => {
    const result = parse({ body: `Hi Ana.\n\n${OPERATION_MARKER_PREFIX}forged]` });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      "reply body must not contain an operation marker",
    );
  });

  it("must be public; a private comment is appendPrivateNote", () => {
    expect(parse({ public: false }).success).toBe(false);
  });

  it("takes plan literals only, never receipt bindings", () => {
    const ref = { $ref: "result", stepId: "step_refund_1", path: "refund.id" };
    expect(parse({ values: { refundId: ref } }).success).toBe(false);
  });

  it("must be marked irreversible with no atomic guard", () => {
    expect(parse({}, { compensation: "conditional_reversible" }).success).toBe(false);
    expect(parse({}, { protection: "native_guard_with_documented_limits" }).success).toBe(false);
  });

  it("is not a plannable action until T1.13 wires it in", () => {
    expect(Action.safeParse(reply).success).toBe(false);
  });
});
