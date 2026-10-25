import type {
  Action,
  PlanManifest,
  RehearsalScenarioRef,
  RehearsalStepOutcome,
  RehearsalVerification,
} from "@rehearsal/contracts";
import type { ResolvedEffect, ResolvedScenario, ResolvedStep } from "./challenges";
import { resolveScenario } from "./challenges";
import { operationKey } from "./executor";
import { planHash } from "./hash";
import { rehearsalOperationKey, snapshotDigest } from "./rehearsal";
import { operationMarker, replyBodyFor } from "./templates";

/**
 * T4.12: judge a rehearsal from independent reads (decision 0013, §5). The receipts are labels
 * the executor wrote about itself. A confirmed label with a green effect does not make a step
 * match, and a read that failed or stopped early is not proof that an effect is absent.
 *
 * The version is part of the report. A later verifier is a different read, so an old report goes
 * stale instead of being rewritten.
 */
export const VERIFIER_VERSION = "verifier@1";

export type ReadResult<T> = { ok: true; value: T } | { ok: false; detail: string };

export interface RefundView {
  id: string;
  amountMinor: number;
  currency: string;
  status: string;
  chargeId: string;
}

export interface CreditView {
  id: string;
  /** Stripe's signed amount, in minor units. A credit is negative. */
  amountMinor: number;
  currency: string;
  type: string;
  chargeId: string | null;
}

export interface CommentView {
  body: string;
  public: boolean;
}

/** What an independent read of the rehearsal tenant returned. A missing key was not read. */
export interface VerifierReads {
  refunds: Record<string, ReadResult<{ complete: boolean; refunds: RefundView[] }>>;
  queries: Record<string, ReadResult<{ complete: boolean; matchingIds: string[] }>>;
  tickets: Record<string, ReadResult<{ priority: string | null; status: string }>>;
  comments: Record<string, ReadResult<{ complete: boolean; comments: CommentView[] }>>;
  credits: Record<string, ReadResult<{ complete: boolean; credits: CreditView[] }>>;
  slack: Record<string, ReadResult<{ complete: boolean; texts: string[] }>>;
}

export interface RehearsalJudgment {
  verdict: "passed" | "failed" | "unknown";
  steps: { actionId: string; verification: RehearsalVerification }[];
  /** Added to the report when a read could not establish every step. */
  limitations: string[];
}

export interface VerifyInput {
  manifest: PlanManifest;
  rehearsalId: string;
  planHash: string;
  snapshotDigest: string;
  /** The version this judgment claims to be. Anything else stays unverified. */
  verifierVersion: string;
  scenario: RehearsalScenarioRef;
  /** Receipt outcomes, used only to describe a label that disagrees with the world. */
  results: readonly { actionId: string; outcome: RehearsalStepOutcome }[];
  reads: VerifierReads;
}

type Observed =
  | { kind: "unverified"; detail: string }
  | { kind: "absent"; detail: string }
  | { kind: "once"; detail: string }
  | { kind: "duplicate"; detail: string }
  | { kind: "wrong"; detail: string };

const UNREAD = "an independent read could not establish every step";

/**
 * Compare the reads to the scenario bound to this plan. The plan hash, the snapshot digest and
 * the verifier version have to be the ones this manifest would produce; a mismatch is unverified,
 * not a pass and not a claim that the world was wrong.
 */
export function verifyRehearsal(input: VerifyInput): RehearsalJudgment {
  const refuse = (detail: string): RehearsalJudgment => ({
    verdict: "unknown",
    limitations: [UNREAD],
    steps: input.manifest.actions.map((action) => ({
      actionId: action.id,
      verification: { status: "unverified", detail },
    })),
  });
  if (input.verifierVersion !== VERIFIER_VERSION) {
    return refuse(`verifier version is not ${VERIFIER_VERSION}`);
  }
  if (planHash(input.manifest) !== input.planHash) {
    return refuse("the plan hash does not match this manifest");
  }
  if (snapshotDigest(input.manifest) !== input.snapshotDigest) {
    return refuse("the snapshot digest does not match the plan's evidence");
  }
  const bound = resolveScenario(input.manifest, input.scenario);
  if (!bound.ok) return refuse(bound.reason);

  const steps = input.manifest.actions.map((action) => ({
    actionId: action.id,
    verification: judgeAction(input, bound.scenario, action),
  }));
  const mismatched = steps.some((step) => step.verification.status === "mismatched");
  const verdict = mismatched
    ? "failed"
    : steps.length > 0 && steps.every((step) => step.verification.status === "matched")
      ? "passed"
      : "unknown";
  return {
    verdict,
    steps,
    limitations: steps.some((step) => step.verification.status === "unverified") ? [UNREAD] : [],
  };
}

function judgeAction(
  input: VerifyInput,
  scenario: ResolvedScenario,
  action: Action,
): RehearsalVerification {
  const step = scenario.steps.find((item) => item.actionId === action.id);
  if (!step) {
    return { status: "unverified", detail: "the scenario names no outcome for this step" };
  }
  if (step.outcome === "unknown_outcome") {
    return { status: "unverified", detail: "the scenario leaves this step unresolved" };
  }
  const receipt = input.results.find((item) => item.actionId === action.id)?.outcome;
  const observed = observe(input, scenario, action, step);
  if (observed.kind === "unverified") return { status: "unverified", detail: observed.detail };
  return settle(step.outcome, observed, receipt);
}

function observe(
  input: VerifyInput,
  scenario: ResolvedScenario,
  action: Action,
  step: ResolvedStep,
): Observed {
  switch (action.kind) {
    case "stripe.refund.create":
      return observeRefund(input, scenario, action, step);
    case "stripe.customer.balanceCredit":
      return observeCredit(input.reads, action, step);
    case "zendesk.ticket.patchFields":
      return observePatch(input.reads, scenario, action, step);
    case "zendesk.ticket.appendPrivateNote":
      return observeNote(input, action, step);
    case "zendesk.ticket.appendPublicReply":
      return observeReply(input, action, step);
    case "slack.message.postSummary":
      return observeSlack(input, action, step);
    default:
      return { kind: "unverified", detail: "this verifier does not read that step" };
  }
}

function observeRefund(
  input: VerifyInput,
  scenario: ResolvedScenario,
  action: Extract<Action, { kind: "stripe.refund.create" }>,
  step: ResolvedStep,
): Observed {
  const effect = scenario.effects.find(
    (item): item is Extract<ResolvedEffect, { kind: "refund_count" }> =>
      item.kind === "refund_count" && item.actionId === action.id,
  );
  if (effect && effect.chargeId !== action.args.chargeId) {
    return { kind: "unverified", detail: "the scenario's refund effect cites another charge" };
  }
  const wanted = wantedCount(step, effect?.count);
  if (wanted === "unresolved") {
    return { kind: "unverified", detail: "the scenario leaves this step unresolved" };
  }
  if (wanted === "contradiction") {
    return {
      kind: "unverified",
      detail: "the scenario expects this step confirmed and no refund",
    };
  }
  const observed = classifyRefund(action, input.reads.refunds[action.args.chargeId]);
  if (observed.kind === "unverified") return observed;
  const count = observed.kind === "once" ? 1 : observed.kind === "duplicate" ? 2 : 0;
  if (observed.kind === "wrong" || (wanted === 1 ? count !== 1 : count !== 0)) return observed;
  const membership = checkMembership(action.queryEvidence, scenario, input.reads);
  if (membership) return membership;
  return observed;
}

function observeCredit(
  reads: VerifierReads,
  action: Extract<Action, { kind: "stripe.customer.balanceCredit" }>,
  step: ResolvedStep,
): Observed {
  const wanted = wantedCount(step, undefined);
  if (wanted === "unresolved" || wanted === "contradiction") {
    return { kind: "unverified", detail: "the scenario leaves this step unresolved" };
  }
  const read = reads.credits[action.args.customerId];
  if (!read) return { kind: "unverified", detail: "no independent read of this credit" };
  if (!read.ok) return { kind: "unverified", detail: read.detail };
  if (!read.value.complete) {
    return {
      kind: "unverified",
      detail: "the credit list did not finish, so it is not proof the effect is absent",
    };
  }
  const { amountMinor, currency } = action.args.amount;
  for (const credit of read.value.credits) {
    if (!Number.isInteger(credit.amountMinor)) {
      return {
        kind: "unverified",
        detail: "a credit amount is not an integer number of minor units",
      };
    }
  }
  const exact = read.value.credits.filter(
    (credit) =>
      (credit.type === "adjustment" || credit.type === "credit_note") &&
      credit.chargeId === action.args.chargeId &&
      credit.amountMinor === -amountMinor &&
      credit.currency.toLowerCase() === currency,
  );
  const other = read.value.credits.filter(
    (credit) =>
      (credit.type === "adjustment" || credit.type === "credit_note") &&
      credit.chargeId === action.args.chargeId &&
      credit.amountMinor < 0 &&
      !exact.includes(credit),
  );
  if (exact.length === 1 && other.length === 0) {
    return {
      kind: "once",
      detail: `one credit of ${amountMinor} ${currency} on ${action.args.chargeId}`,
    };
  }
  if (exact.length > 1) {
    return {
      kind: "duplicate",
      detail: `duplicate effect: ${exact.length} credits of ${amountMinor} ${currency} on ${action.args.chargeId}`,
    };
  }
  if (other.length > 0) {
    const found = other[0];
    return {
      kind: "wrong",
      detail: `wrong effect: a credit of ${action.args.chargeId} is ${found ? -found.amountMinor : "?"} ${found?.currency ?? currency}, not ${amountMinor} ${currency}`,
    };
  }
  return {
    kind: "absent",
    detail: `no credit of ${amountMinor} ${currency} on ${action.args.chargeId}`,
  };
}

function observePatch(
  reads: VerifierReads,
  scenario: ResolvedScenario,
  action: Extract<Action, { kind: "zendesk.ticket.patchFields" }>,
  step: ResolvedStep,
): Observed {
  const effect = scenario.effects.find(
    (item): item is Extract<ResolvedEffect, { kind: "ticket_field" }> =>
      item.kind === "ticket_field" && item.actionId === action.id,
  );
  const read = reads.tickets[action.args.ticketId];
  if (!read) return { kind: "unverified", detail: "no independent read of this ticket" };
  if (!read.ok) return { kind: "unverified", detail: read.detail };
  const ticket = read.value;
  const priority =
    step.outcome === "confirmed"
      ? (effect?.value ?? action.args.set.priority)
      : action.args.set.priority !== undefined || effect
        ? (action.args.before.priority ?? null)
        : undefined;
  const status =
    action.args.set.status === undefined
      ? undefined
      : step.outcome === "confirmed"
        ? action.args.set.status
        : (action.args.before.status ?? null);
  const problems: string[] = [];
  if (priority !== undefined && ticket.priority !== priority) {
    problems.push(`priority is ${ticket.priority ?? "unset"}, not ${priority ?? "unset"}`);
  }
  if (status !== undefined && ticket.status !== status) {
    problems.push(`status is ${ticket.status}, not ${status}`);
  }
  if (problems.length === 0) {
    const detail = priority !== undefined ? `priority is ${priority}` : `status is ${status}`;
    return { kind: step.outcome === "confirmed" ? "once" : "absent", detail };
  }
  // Still at the pre-write value: the patch did not land. A different value is the wrong effect.
  const atBefore =
    (priority === undefined || ticket.priority === (action.args.before.priority ?? null)) &&
    (status === undefined || ticket.status === (action.args.before.status ?? null));
  if (step.outcome === "confirmed" && atBefore) {
    return { kind: "absent", detail: problems.join("; ") };
  }
  return { kind: "wrong", detail: problems.join("; ") };
}

function observeNote(
  input: VerifyInput,
  action: Extract<Action, { kind: "zendesk.ticket.appendPrivateNote" }>,
  step: ResolvedStep,
): Observed {
  return classifyComments(
    input,
    action.args.ticketId,
    step,
    false,
    `the private note is not on ticket ${action.args.ticketId}`,
    "one private note carries the operation marker",
  );
}

function observeReply(
  input: VerifyInput,
  action: Extract<Action, { kind: "zendesk.ticket.appendPublicReply" }>,
  step: ResolvedStep,
): Observed {
  let body: string;
  try {
    body = replyBodyFor(action);
  } catch (err) {
    return { kind: "unverified", detail: (err as Error).message };
  }
  return classifyComments(
    input,
    action.args.ticketId,
    step,
    true,
    `the public reply is not on ticket ${action.args.ticketId}`,
    "one public reply carries the approved text",
    body,
  );
}

function observeSlack(
  input: VerifyInput,
  action: Extract<Action, { kind: "slack.message.postSummary" }>,
  _step: ResolvedStep,
): Observed {
  const read = input.reads.slack[action.args.channelId];
  if (!read) return { kind: "unverified", detail: "no independent read of this channel" };
  if (!read.ok) return { kind: "unverified", detail: read.detail };
  if (!read.value.complete) {
    return {
      kind: "unverified",
      detail: "the channel history did not finish, so it is not proof the summary is absent",
    };
  }
  const marker = markerFor(input, action);
  const hits = read.value.texts.filter((text) => text.includes(marker));
  if (hits.length > 1) {
    return {
      kind: "duplicate",
      detail: `duplicate effect: ${hits.length} messages carry the operation marker`,
    };
  }
  if (hits.length === 1)
    return { kind: "once", detail: "one summary carries the operation marker" };
  return { kind: "absent", detail: "the summary is not in the channel" };
}

function classifyRefund(
  action: Extract<Action, { kind: "stripe.refund.create" }>,
  read: VerifierReads["refunds"][string] | undefined,
): Observed {
  const { amountMinor, currency } = action.args.amount;
  const chargeId = action.args.chargeId;
  if (!read) return { kind: "unverified", detail: "no independent read of this refund" };
  if (!read.ok) return { kind: "unverified", detail: read.detail };
  if (!read.value.complete) {
    return {
      kind: "unverified",
      detail: "the refund list did not finish, so it is not proof the effect is absent",
    };
  }
  for (const refund of read.value.refunds) {
    if (!Number.isInteger(refund.amountMinor)) {
      return {
        kind: "unverified",
        detail: "a refund amount is not an integer number of minor units",
      };
    }
  }
  const pending = read.value.refunds.filter(
    (refund) =>
      refund.chargeId === chargeId &&
      (refund.status === "pending" || refund.status === "requires_action"),
  );
  if (pending.length > 0) {
    return {
      kind: "unverified",
      detail: "a refund of this charge is still pending, so the effect is unresolved",
    };
  }
  const exact = read.value.refunds.filter(
    (refund) =>
      refund.chargeId === chargeId &&
      refund.status === "succeeded" &&
      refund.amountMinor === amountMinor &&
      refund.currency.toLowerCase() === currency,
  );
  const other = read.value.refunds.filter(
    (refund) =>
      refund.chargeId === chargeId && refund.status === "succeeded" && !exact.includes(refund),
  );
  if (exact.length === 1 && other.length === 0) {
    return { kind: "once", detail: `one refund of ${amountMinor} ${currency} on ${chargeId}` };
  }
  if (exact.length > 1) {
    return {
      kind: "duplicate",
      detail: `duplicate effect: ${exact.length} refunds of ${amountMinor} ${currency} on ${chargeId}`,
    };
  }
  if (other.length > 0) {
    const found = other[0];
    return {
      kind: "wrong",
      detail: `wrong effect: a refund of ${chargeId} is ${found?.amountMinor ?? "?"} ${found?.currency ?? currency}, not ${amountMinor} ${currency}`,
    };
  }
  return { kind: "absent", detail: `no refund of ${amountMinor} ${currency} on ${chargeId}` };
}

function classifyComments(
  input: VerifyInput,
  ticketId: string,
  step: ResolvedStep,
  isPublic: boolean,
  absent: string,
  once: string,
  body?: string,
): Observed {
  const read = input.reads.comments[ticketId];
  if (!read) return { kind: "unverified", detail: "no independent read of this ticket's comments" };
  if (!read.ok) return { kind: "unverified", detail: read.detail };
  if (!read.value.complete) {
    return {
      kind: "unverified",
      detail: "the comment list did not finish, so it is not proof the note is absent",
    };
  }
  const action = input.manifest.actions.find((item) => item.id === step.actionId);
  if (!action) return { kind: "unverified", detail: "the scenario names no outcome for this step" };
  const marker = markerFor(input, action);
  const marked = read.value.comments.filter(
    (comment) => comment.public === isPublic && comment.body.includes(marker),
  );
  const hits = body ? marked.filter((comment) => comment.body.includes(body)) : marked;
  if (body && marked.length === 1 && hits.length === 0) {
    return {
      kind: "wrong",
      detail: "a comment carries the operation marker but not the approved text",
    };
  }
  if (hits.length > 1) {
    return {
      kind: "duplicate",
      detail: `duplicate effect: ${hits.length} comments carry the operation marker`,
    };
  }
  if (hits.length === 1) return { kind: "once", detail: once };
  return { kind: "absent", detail: absent };
}

/** Membership effects on this step's queries. A partial query is not proof a charge is absent. */
function checkMembership(
  queryEvidence: readonly string[],
  scenario: ResolvedScenario,
  reads: VerifierReads,
): Observed | null {
  const effects = scenario.effects.filter(
    (effect): effect is Extract<ResolvedEffect, { kind: "query_membership" }> =>
      effect.kind === "query_membership" && queryEvidence.includes(effect.queryId),
  );
  for (const effect of effects) {
    const read = reads.queries[effect.queryId];
    if (!read) {
      return { kind: "unverified", detail: `no independent read of query ${effect.queryId}` };
    }
    if (!read.ok) return { kind: "unverified", detail: read.detail };
    if (!read.value.complete) {
      return {
        kind: "unverified",
        detail: `query ${effect.queryId} did not finish, so membership is not proof`,
      };
    }
    const member = read.value.matchingIds.includes(effect.chargeId);
    if (member !== effect.member) {
      return {
        kind: "wrong",
        detail: effect.member
          ? `${effect.chargeId} is not a member of ${effect.queryId}`
          : `${effect.chargeId} is a member of ${effect.queryId}`,
      };
    }
  }
  return null;
}

function wantedCount(
  step: ResolvedStep,
  effect: 0 | 1 | undefined,
): 0 | 1 | "unresolved" | "contradiction" {
  if (step.outcome === "unknown_outcome") return "unresolved";
  const fromStep = step.outcome === "confirmed" ? 1 : 0;
  if (effect !== undefined && effect !== fromStep) return "contradiction";
  return fromStep;
}

function settle(
  expected: RehearsalStepOutcome,
  observed: Exclude<Observed, { kind: "unverified" }>,
  receipt: RehearsalStepOutcome | undefined,
): RehearsalVerification {
  if (expected === "confirmed") {
    if (observed.kind === "once") return { status: "matched", detail: observed.detail };
    if (observed.kind === "absent" && receipt === "held") {
      return {
        status: "mismatched",
        detail: `wrongful hold: ${observed.detail}, and the receipt says held`,
      };
    }
    if (observed.kind === "absent" && receipt === "confirmed") {
      return { status: "mismatched", detail: "missing effect; the receipt says confirmed" };
    }
    if (observed.kind === "absent") {
      return { status: "mismatched", detail: `missing effect: ${observed.detail}` };
    }
    return { status: "mismatched", detail: observed.detail };
  }
  if (observed.kind === "absent") {
    const word =
      expected === "held" ? "held" : expected === "skipped_dependency" ? "skipped" : "rejected";
    return { status: "matched", detail: `${word}: ${observed.detail}` };
  }
  return {
    status: "mismatched",
    detail:
      expected === "held"
        ? `a held step's effect is in the world: ${observed.detail}`
        : `the effect is in the world: ${observed.detail}`,
  };
}

function markerFor(input: VerifyInput, action: Action): string {
  return operationMarker(
    rehearsalOperationKey(
      input.rehearsalId,
      operationKey(input.manifest.orgId, input.manifest.planId, action),
    ),
  );
}
