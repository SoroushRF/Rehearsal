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

export const Action = z.discriminatedUnion("kind", [
  StripeRefundCreate,
  ZendeskTicketPatchFields,
  ZendeskTicketAppendPrivateNote,
]);
export type Action = z.infer<typeof Action>;
export type ActionKind = Action["kind"];
