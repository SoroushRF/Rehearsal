import { z } from "zod";
import { PositiveMoney, ResultRef, Role } from "./common";

/** How an applied effect can be undone. Most real effects can't be. */
export const CompensationClass = z.enum([
  /** Field we own; revert only if it still holds the value we wrote. */
  "conditional_reversible",
  /** Can't be erased; a new, separately approved action may offset it. */
  "compensable_by_new_action",
  /** Appended/sent; stays forever. */
  "irreversible",
]);
export type CompensationClass = z.infer<typeof CompensationClass>;

/** What concurrency protection the provider actually gives this write. Shown to reviewers. */
export const ProtectionLevel = z.enum([
  "native_guard_with_documented_limits",
  "best_effort_reread",
  "no_atomic_guard",
]);
export type ProtectionLevel = z.infer<typeof ProtectionLevel>;

const ActionBase = z.object({
  /** Stable step ID within the plan. */
  id: z.string().min(1),
  /** Customer branch. Actions in one case run sequentially; cases are independent. */
  caseId: z.string().min(1),
  /** The approved obligation this action remedies (e.g. one overcharge). */
  obligationId: z.string().min(1),
  dependsOn: z.array(z.string()),
  requiredRole: Role,
  /** Observation IDs that must still hold at apply time. */
  evidence: z.array(z.string()),
  /** QueryObservation IDs whose membership must still match at apply time. */
  queryEvidence: z.array(z.string()),
  compensation: CompensationClass,
  protection: ProtectionLevel,
  /** Reviewer-facing explanation. Part of the approved content. */
  rationale: z.string(),
});

export const StripeRefundCreate = ActionBase.extend({
  kind: z.literal("stripe.refund.create"),
  args: z.object({
    chargeId: z.string().min(1),
    amount: PositiveMoney,
    reason: z.enum(["requested_by_customer", "duplicate"]),
  }),
});

/**
 * A credit to the customer's Stripe balance, applied to their next invoice, as the remedy for a
 * duplicate charge instead of a refund. Sent as a negative customer balance transaction, so
 * `amount` is the credit and is always positive. The customer's own currency must match: Era
 * accepts any currency here, but Stripe doesn't (docs/capability-matrix.md).
 *
 * Not in `Action` yet, so no plan can carry one. T1.14 adds it once the write adapter (T3.12),
 * the one-remedy guard (T4.10) and the policy (T2.18) handle it.
 */
export const StripeCustomerBalanceCredit = ActionBase.extend({
  kind: z.literal("stripe.customer.balanceCredit"),
  args: z.object({
    customerId: z.string().min(1),
    /** The duplicate charge this credit remedies, so a refund of it counts as the same remedy. */
    chargeId: z.string().min(1),
    amount: PositiveMoney,
  }),
});

export const ZendeskPriority = z.enum(["low", "normal", "high", "urgent"]);
export const ZendeskStatus = z.enum(["open", "pending", "solved"]);

export const ZendeskTicketPatchFields = ActionBase.extend({
  kind: z.literal("zendesk.ticket.patchFields"),
  args: z.object({
    ticketId: z.string().min(1),
    /** Only owned scalar fields. Never whole objects or tag arrays. */
    set: z
      .object({ priority: ZendeskPriority.optional(), status: ZendeskStatus.optional() })
      .refine((s) => Object.keys(s).length > 0, "patch must set at least one field"),
    /** Values observed before the write; used for the conditional undo. */
    before: z.object({
      priority: ZendeskPriority.nullable().optional(),
      status: ZendeskStatus.optional(),
    }),
  }),
});

/** Template substitutions are literals or bindings to confirmed receipts — never model text. */
export const TemplateBinding = z.union([z.string(), z.number(), ResultRef]);

export const ZendeskTicketAppendPrivateNote = ActionBase.extend({
  kind: z.literal("zendesk.ticket.appendPrivateNote"),
  args: z.object({
    ticketId: z.string().min(1),
    public: z.literal(false),
    template: z.object({ id: z.string().min(1), version: z.int().positive() }),
    bindings: z.record(z.string(), TemplateBinding),
  }),
});

/** The text that starts every operation marker. No approved text may contain it. */
export const OPERATION_MARKER_PREFIX = "[rehearsal-op:";

/**
 * A public reply on the customer's ticket. Unlike a private note, the customer reads it, so the
 * reviewer approves the exact text: `body` is the template rendered with plan literals only (no
 * receipt bindings), and it is part of the plan hash. The executor sends `body` followed by the
 * operation marker. Zendesk has no exactly-once append, so a reply with an unknown outcome is
 * resolved by reading the ticket's comments for that marker and is never re-sent blindly.
 *
 * Not in `Action` yet, so no plan can carry one. T1.13 adds it once the write adapter (T3.11)
 * and the review UI and policy (T2.16) handle it.
 */
export const ZendeskTicketAppendPublicReply = ActionBase.extend({
  kind: z.literal("zendesk.ticket.appendPublicReply"),
  /** A sent reply stays forever. */
  compensation: z.literal("irreversible"),
  protection: z.literal("no_atomic_guard"),
  args: z.object({
    ticketId: z.string().min(1),
    public: z.literal(true),
    template: z.object({ id: z.string().min(1), version: z.int().positive() }),
    /** Plan literals the template was rendered with, so the server can render it again. */
    values: z.record(z.string(), z.union([z.string(), z.number()])),
    /** The rendered text, exactly as approved and sent, without the marker. */
    body: z
      .string()
      .refine((s) => s.trim().length > 0, "reply body must not be blank")
      .refine(
        (s) => !s.includes(OPERATION_MARKER_PREFIX),
        "reply body must not contain an operation marker",
      ),
  }),
});

/**
 * Receipt outcomes a summary may count. Mirrors `ReceiptOutcome` in execution.ts, which imports
 * this module and so can't be imported here.
 */
export const SummaryOutcome = z.enum([
  "confirmed",
  "rejected",
  "held",
  "unknown_outcome",
  "skipped_dependency",
  "compensated",
  "compensation_conflict",
]);

/** The number of listed steps whose receipt has one of `outcomes`, resolved by the executor. */
export const OutcomeCount = z.object({
  $count: z.literal("outcomes"),
  stepIds: z.array(z.string().min(1)).min(1),
  outcomes: z.array(SummaryOutcome).min(1),
});
export type OutcomeCount = z.infer<typeof OutcomeCount>;

/** Summary substitutions are literals or counts of approved steps' outcomes — never model text. */
export const SummaryBinding = z.union([z.string(), z.number(), OutcomeCount]);

/**
 * One Slack post summarising the run, as its final step. The text is rendered at apply from an
 * approved template plus literals and outcome counts, followed by the operation marker. Slack
 * doesn't deduplicate posts (not even on `client_msg_id`), so a post with an unknown outcome is
 * resolved by reading the channel for that marker and is never re-sent blindly.
 *
 * It runs after every other step has settled, held or not, so it counts what really happened; a
 * held or skipped step it counts doesn't skip it.
 */
export const SlackMessagePostSummary = ActionBase.extend({
  kind: z.literal("slack.message.postSummary"),
  /** A post stays forever and Slack has no conditional write. */
  compensation: z.literal("irreversible"),
  protection: z.literal("no_atomic_guard"),
  args: z.object({
    channelId: z.string().min(1),
    template: z.object({ id: z.string().min(1), version: z.int().positive() }),
    bindings: z.record(z.string(), SummaryBinding),
  }),
}).refine(
  (a) =>
    Object.values(a.args.bindings).every(
      (b) => typeof b !== "object" || b.stepIds.every((id) => a.dependsOn.includes(id)),
    ),
  { message: "a summary must depend on every step it counts", path: ["args", "bindings"] },
);

export const Action = z.discriminatedUnion("kind", [
  StripeRefundCreate,
  ZendeskTicketPatchFields,
  ZendeskTicketAppendPrivateNote,
  SlackMessagePostSummary,
]);
export type Action = z.infer<typeof Action>;
export type ActionKind = Action["kind"];
