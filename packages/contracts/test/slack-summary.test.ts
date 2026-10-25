import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Action,
  ReceiptOutcome,
  SlackMessagePostSummary,
  StripeRefundCreate,
  SummaryOutcome,
} from "../src";

const refunds = ["step_refund_1", "step_refund_2"];
const notes = ["step_note_1", "step_note_2"];

const summary = {
  id: "step_summary",
  caseId: "run",
  obligationId: "run_summary",
  dependsOn: [...refunds, ...notes],
  requiredRole: "support_lead",
  evidence: [],
  queryEvidence: [],
  compensation: "irreversible",
  protection: "no_atomic_guard",
  rationale: "Tell #billing-ops what the run did.",
  kind: "slack.message.postSummary",
  args: {
    channelId: "C0BILLINGOPS",
    template: { id: "run-summary", version: 1 },
    bindings: {
      incident: "inc_dup_2026_10",
      refunded: { $count: "outcomes", stepIds: refunds, outcomes: ["confirmed"] },
      held: { $count: "outcomes", stepIds: refunds, outcomes: ["held", "unknown_outcome"] },
    },
  },
};

const parse = (overrides: Record<string, unknown>, args: Record<string, unknown> = {}) =>
  SlackMessagePostSummary.safeParse({
    ...summary,
    ...overrides,
    args: { ...summary.args, ...args },
  });

describe("slack.message.postSummary (T1.17)", () => {
  it("parses a summary of literals and outcome counts over steps it depends on", () => {
    const parsed = SlackMessagePostSummary.parse(summary);
    expect(parsed.args.bindings.refunded).toEqual({
      $count: "outcomes",
      stepIds: refunds,
      outcomes: ["confirmed"],
    });
  });

  it("refuses a count over a step the summary doesn't depend on", () => {
    const result = parse({ dependsOn: notes });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("a summary must depend on every step it counts");
  });

  it("refuses free text in place of an approved template", () => {
    expect(parse({}, { template: undefined, text: "All refunds done!" }).success).toBe(false);
  });

  it("refuses bindings that aren't literals or outcome counts", () => {
    const ref = { $ref: "result", stepId: refunds[0], path: "refund.id" };
    expect(parse({}, { bindings: { refundId: ref } }).success).toBe(false);
    const empty = { $count: "outcomes", stepIds: [], outcomes: ["confirmed"] };
    expect(parse({}, { bindings: { n: empty } }).success).toBe(false);
    const bogus = { $count: "outcomes", stepIds: refunds, outcomes: ["applied"] };
    expect(parse({}, { bindings: { n: bogus } }).success).toBe(false);
  });

  it("must be marked irreversible with no atomic guard", () => {
    expect(parse({ compensation: "compensable_by_new_action" }).success).toBe(false);
    expect(parse({ protection: "best_effort_reread" }).success).toBe(false);
  });

  it("counts exactly the receipt outcomes", () => {
    expect(SummaryOutcome.options).toEqual(ReceiptOutcome.options);
  });

  it("can join a discriminated union with its refinement intact", () => {
    const Union = z.discriminatedUnion("kind", [StripeRefundCreate, SlackMessagePostSummary]);
    expect(Union.safeParse(summary).success).toBe(true);
    expect(Union.safeParse({ ...summary, dependsOn: notes }).success).toBe(false);
  });

  it("is a plannable action (T1.7), with its refinement intact", () => {
    expect(Action.safeParse(summary).success).toBe(true);
    expect(Action.safeParse({ ...summary, dependsOn: notes }).success).toBe(false);
  });
});
