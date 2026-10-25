import { z } from "zod";

/**
 * T4.14: the shapes of a held-out set. A set is an incident (seeded like INC-BILL-0927, with new
 * IDs), its tasks, and a gold file written by hand before anything was run on it. Gold lives in
 * its own folder and module so planner and baseline code can't reach it by accident.
 */

const CaseKey = z.string().regex(/^[a-z]\d{2}$/);
const Instant = z.iso.datetime();
const Priority = z.enum(["low", "normal", "high", "urgent"]);
const ChargeId = z.string().regex(/^ch_[A-Za-z0-9]+$/);
const CustomerId = z.string().regex(/^cus_[A-Za-z0-9]+$/);

export const IncidentCase = z.strictObject({
  key: CaseKey,
  kind: z.enum([
    "duplicate",
    "triple",
    "control_distinct",
    "control_other_currency",
    "control_outside_window",
    "control_failed_retry",
  ]),
  customerId: CustomerId,
  name: z.string().min(1),
  email: z.email(),
  requesterId: z.int().positive(),
  amountMinor: z.int().positive(),
  currency: z.enum(["cad", "usd"]),
  chargedAt: Instant,
  billingCurrency: z.enum(["cad", "usd"]).optional(),
  ticketExternalId: CustomerId.optional(),
});

export const Incident = z.strictObject({
  incident: z.string().regex(/^INC-BILL-\d{4}$/),
  summary: z.string().min(1),
  window: z.strictObject({ createdGte: Instant, createdLt: Instant }),
  ids: z.strictObject({
    prefix: z.string().regex(/^INC\d{4}$/),
    ticketBase: z.int().positive(),
  }),
  cases: z.array(IncidentCase).min(5),
});
export type Incident = z.infer<typeof Incident>;

/** State planted in both worlds after seeding and before planning, through ordinary API calls. */
export const Setup = z.discriminatedUnion("kind", [
  /** Someone refunded charge `charge` (an index into the case's charges) before the incident. */
  z.strictObject({ kind: z.literal("refund_charge"), caseKey: CaseKey, charge: z.int().min(0) }),
  /** A balance credit of the case's amount, tagged `metadata[charge]` with that charge. */
  z.strictObject({ kind: z.literal("balance_credit"), caseKey: CaseKey, charge: z.int().min(0) }),
]);
export type Setup = z.infer<typeof Setup>;

/** What changes in the operational world after approval and before the writes. */
export const Drift = z.discriminatedUnion("kind", [
  /** A copy of the case's last charge with a new ID, inside the window. */
  z.strictObject({
    kind: z.literal("phantom_charge"),
    caseKey: CaseKey,
    chargeId: ChargeId,
    at: Instant,
  }),
  /** The same, dated after the window. */
  z.strictObject({
    kind: z.literal("late_charge"),
    caseKey: CaseKey,
    chargeId: ChargeId,
    at: Instant,
  }),
  /** The same, dated before the window. */
  z.strictObject({
    kind: z.literal("early_charge"),
    caseKey: CaseKey,
    chargeId: ChargeId,
    at: Instant,
  }),
  /** A charge for a customer outside the incident. */
  z.strictObject({
    kind: z.literal("stranger_charge"),
    chargeId: ChargeId,
    customerId: CustomerId,
    at: Instant,
  }),
  /** The customer adds a public comment. */
  z.strictObject({ kind: z.literal("public_comment"), caseKey: CaseKey }),
  /** A teammate adds a tag to the ticket. */
  z.strictObject({ kind: z.literal("teammate_tag"), caseKey: CaseKey, tag: z.string().min(1) }),
  /** A teammate sets the ticket's priority. */
  z.strictObject({ kind: z.literal("teammate_priority"), caseKey: CaseKey, priority: Priority }),
  /** A teammate refunds the case's first charge. */
  z.strictObject({ kind: z.literal("teammate_refund_original"), caseKey: CaseKey }),
]);
export type Drift = z.infer<typeof Drift>;

/** Transport faults, as in the scorecard, plus a failed read of the case's charges on re-check. */
export const Fault = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("throttle_first_refund") }),
  z.strictObject({ kind: z.literal("lose_refund_response"), caseKey: CaseKey }),
  z.strictObject({ kind: z.literal("lose_credit_response"), caseKey: CaseKey }),
  z.strictObject({ kind: z.literal("lose_note_response"), caseKey: CaseKey }),
  z.strictObject({ kind: z.literal("lose_reply_response"), caseKey: CaseKey }),
  /** Operational re-reads of the case's charge list fail. Planning reads are unaffected. */
  z.strictObject({ kind: z.literal("fail_charge_list_read"), caseKey: CaseKey }),
]);
export type Fault = z.infer<typeof Fault>;

/** Changes outside the provider worlds, after approval. */
export const Event = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("precedent_withdrawn"), precedentId: z.string().min(1) }),
]);

/** The content a finance lead would promote (the T2.17 route body), not a stored record. */
export const Precedent = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  appliesTo: z.string().regex(/^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/),
  statement: z.string().min(1),
  conditions: z.array(z.string().min(1)),
  exceptions: z.array(z.string().min(1)),
  effectiveFrom: z.iso.date(),
  effectiveUntil: z.iso.date().nullable(),
});

export const Task = z.strictObject({
  id: z.string().regex(/^HO\d-\d+$/),
  title: z.string().min(1),
  /** Cases the planner is asked about. Every case is scored, in scope or not. */
  scope: z.union([z.literal("all"), z.array(CaseKey).min(1)]),
  drift: z.array(Drift).default([]),
  faults: z.array(Fault).default([]),
  events: z.array(Event).default([]),
  /** Harness features the task can't run without. A runner without them reports it not run. */
  requires: z.array(z.enum(["precedent_registry"])).default([]),
  /** Planner modes the task applies to; absent means every mode. */
  modes: z.array(z.enum(["memory", "no_memory"])).optional(),
});
export type Task = z.infer<typeof Task>;

export const Tasks = z.strictObject({
  set: z.string().regex(/^ho\d$/),
  version: z.int().positive(),
  policy: z.strictObject({ id: z.literal("billing-remedy"), version: z.int().positive() }),
  /** What the planning session turns on, as in the scorecard's Ops, but the agent picks the remedy. */
  ops: z.strictObject({ credits: z.boolean(), replies: z.boolean(), summary: z.boolean() }),
  setup: z.array(Setup),
  precedents: z.array(Precedent),
  tasks: z.array(Task).min(1),
});
export type Tasks = z.infer<typeof Tasks>;

export const Op = z.enum([
  "stripe.refund.create",
  "stripe.customer.balanceCredit",
  "zendesk.ticket.patchFields",
  "zendesk.ticket.appendPrivateNote",
  "zendesk.ticket.appendPublicReply",
  "slack.message.postSummary",
]);

/**
 * Why an op must not apply. Product-neutral on purpose: a runner maps its own hold reasons onto
 * these, and an op that is never proposed satisfies the gold as well as one that is held.
 */
export const Cause = z.enum([
  "policy",
  "ownership",
  "evidence_changed",
  "evidence_unavailable",
  "remedy_exists",
  "precedent_changed",
]);

/**
 * One acceptable end state of a case, read back from the operational world after the run.
 * Refunds and credits are exact and include any planted in setup or by drift. Notes and replies
 * are caps: more is a duplicate or a false claim, fewer isn't scored. A null priority means any.
 */
export const End = z.strictObject({
  refunds: z.int().min(0),
  credits: z.int().min(0),
  notesMax: z.int().min(0),
  repliesMax: z.int().min(0),
  priority: Priority.nullable(),
});
export type End = z.infer<typeof End>;

const Role = z.enum(["support_lead", "finance_lead"]);

export const CaseGold = z.strictObject({
  /** Names of ends in the file's `ends`; any one of them passes. */
  accept: z.array(z.string().min(1)).min(1),
  /** Ops that must not apply for this case, whether held or never proposed. */
  mustNotApply: z.array(z.strictObject({ op: Op, cause: Cause })).default([]),
  /** Roles that must sign a plan that remedies this case. */
  signers: z.array(Role).optional(),
  why: z.string().min(1).optional(),
});
export type CaseGold = z.infer<typeof CaseGold>;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const Gold = z.strictObject({
  set: z.string().regex(/^ho\d$/),
  version: z.int().positive(),
  split: z.literal("held-out"),
  /** `authored` until a run against Era has used it; the gold itself never becomes evidence. */
  evidence: z.literal("authored"),
  authoredAt: z.iso.date(),
  /** Digests of the inputs the gold was written against. Changing an input means re-authoring. */
  inputs: z.strictObject({ incident: Sha256, tasks: Sha256, policy: Sha256 }),
  ends: z.record(z.string(), End),
  tasks: z.record(
    z.string(),
    z.strictObject({
      why: z.string().min(1),
      /** Acceptable counts of Slack run-summary posts. */
      summaryPosts: z.array(z.int().min(0)).min(1),
      cases: z.record(CaseKey, CaseGold),
    }),
  ),
});
export type Gold = z.infer<typeof Gold>;
