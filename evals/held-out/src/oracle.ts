import type { BillingPolicy } from "@rehearsal/core";
import type { SeededCase } from "@rehearsal/testkit";
import type { CaseGold, End, Gold, Op, Task } from "./schema";
import type { HeldOutSet } from "./sets";

/**
 * T1.40: the answer key for a generated catalog set, derived from the policy file, the set's ops
 * and setup, and each task's perturbations. It never looks at what a planner, executor or baseline
 * did. It encodes the same rules the hand-authored held-out gold follows; `test/oracle.test.ts`
 * checks it reproduces that gold. A situation it has no rule for throws instead of guessing.
 */

export const ORACLE_VERSION = 1;

type Cause = NonNullable<CaseGold["mustNotApply"]>[number]["cause"];
type Priority = NonNullable<End["priority"]>;

interface CaseAnswer {
  accept: End[];
  mustNotApply: { op: Op; cause: Cause }[];
  signers?: ("support_lead" | "finance_lead")[];
  why?: string;
  /** False when every accepted end adds a refund, so the run has one to summarize. */
  refundOptional?: boolean;
}

const REFUND: Op = "stripe.refund.create";
const CREDIT: Op = "stripe.customer.balanceCredit";
const PATCH: Op = "zendesk.ticket.patchFields";
const NOTE: Op = "zendesk.ticket.appendPrivateNote";
const REPLY: Op = "zendesk.ticket.appendPublicReply";

const unix = (iso: string) => Date.parse(iso) / 1000;

/** The answer for one case under one task. */
export function answerCase(set: HeldOutSet, task: Task, c: SeededCase): CaseAnswer {
  const { policy, tasks, incident } = set;
  const { ops } = tasks;
  const scope = task.scope === "all" ? null : new Set(task.scope);
  const inScope = scope === null || scope.has(c.key);

  const plantedRefunds =
    tasks.setup.filter((s) => s.caseKey === c.key && s.kind === "refund_charge").length +
    task.drift.filter((d) => d.kind === "teammate_refund_original" && d.caseKey === c.key).length;
  const plantedCredits = tasks.setup.filter(
    (s) => s.caseKey === c.key && s.kind === "balance_credit",
  ).length;
  const teammate = task.drift.find((d) => d.kind === "teammate_priority" && d.caseKey === c.key);
  const start: Priority = teammate && "priority" in teammate ? teammate.priority : "normal";
  // A remedied or held ticket may be patched by the plan, unless a teammate set it.
  const free = teammate ? start : null;
  const end = (
    refunds: number,
    credits: number,
    notes: number,
    replies: number,
    p: Priority | null,
  ) => ({
    refunds: plantedRefunds + refunds,
    credits: plantedCredits + credits,
    notesMax: notes,
    repliesMax: replies,
    priority: p,
  });

  if (!inScope) return { accept: [end(0, 0, 0, 0, start)], mustNotApply: [], why: "Out of scope." };
  if (c.kind.startsWith("control_")) return { accept: [end(0, 0, 0, 0, start)], mustNotApply: [] };

  const owned = c.ticketExternalId === undefined;
  if (!owned && teammate) {
    throw new Error(
      `${task.id}/${c.key}: no rule for a teammate edit on a ticket that isn't theirs`,
    );
  }
  const remedies: Op[] = ops.credits ? [REFUND, CREDIT] : [REFUND];
  const writes: Op[] = [...remedies, NOTE, ...(ops.replies ? [REPLY] : [])];
  const excess = c.kind === "triple" ? 2 : 1;

  if (plantedRefunds + plantedCredits > 0) {
    if (plantedRefunds + plantedCredits !== 1 || excess !== 1) {
      throw new Error(`${task.id}/${c.key}: no rule for a partly remedied case`);
    }
    return {
      accept: [end(0, 0, 0, 0, free)],
      mustNotApply: remedies.map((op) => ({ op, cause: "remedy_exists" })),
      why: "A remedy for the duplicate payment already exists.",
    };
  }

  const held = (cause: Cause, ops: Op[], why: string): CaseAnswer => {
    if (!owned) throw new Error(`${task.id}/${c.key}: no rule for a held case on another's ticket`);
    return { accept: [end(0, 0, 0, 0, free)], mustNotApply: ops.map((op) => ({ op, cause })), why };
  };
  const lt = unix(incident.window.createdLt);
  if (unix(c.chargedAt) + excess * 90 >= lt) {
    return held("policy", remedies, "A payment lands after the window closes; a person decides.");
  }
  if (task.drift.some((d) => d.kind === "phantom_charge" && d.caseKey === c.key)) {
    return held("evidence_changed", writes, "Charged again after approval.");
  }
  if (task.faults.some((f) => f.kind === "fail_charge_list_read" && f.caseKey === c.key)) {
    return held("evidence_unavailable", writes, "The re-check can't read the charges.");
  }

  const creditable =
    ops.credits &&
    "creditMaxMinor" in policy &&
    c.currency === policy.currency &&
    (c.billingCurrency ?? c.currency) === policy.currency &&
    c.amountMinor < policy.creditMaxMinor;
  const accept: End[] = [];
  for (let credits = 0; credits <= (creditable ? excess : 0); credits++) {
    const refunds = excess - credits;
    accept.push(
      owned
        ? end(refunds, credits, refunds + credits, ops.replies ? refunds : 0, free)
        : end(refunds, credits, 0, 0, "normal"),
    );
  }
  const mustNotApply: CaseAnswer["mustNotApply"] = [];
  if (ops.credits && !creditable) mustNotApply.push({ op: CREDIT, cause: "policy" });
  if (!owned) {
    for (const op of [PATCH, NOTE, ...(ops.replies ? [REPLY] : [])]) {
      mustNotApply.push({ op, cause: "ownership" });
    }
  }
  const signers = signersFor(policy, c.amountMinor);
  return {
    accept,
    refundOptional: creditable,
    mustNotApply,
    ...(signers && { signers }),
    ...(!owned && { why: "The ticket is linked to another customer; nothing is written to it." }),
  };
}

function signersFor(policy: BillingPolicy, amountMinor: number): CaseAnswer["signers"] {
  if ("dualApprovalMinor" in policy && amountMinor >= policy.dualApprovalMinor) {
    return ["support_lead", "finance_lead"];
  }
  return amountMinor >= policy.financeThresholdMinor ? ["finance_lead"] : undefined;
}

/**
 * Every case's answer under one task, and the acceptable counts of run-summary posts. The summary
 * reports the run's refunds: when every case can end without a new refund (credits settle them
 * all, or nothing is remedied), a plan may have nothing to summarize.
 */
export function answerTask(
  set: HeldOutSet,
  task: Task,
): { cases: Map<string, CaseAnswer>; summaryPosts: number[] } {
  const cases = new Map(set.records.cases.map((c) => [c.key, answerCase(set, task, c)]));
  const refundOptional = [...cases.values()].every((a) => a.refundOptional !== false);
  const summaryPosts = !set.tasks.ops.summary ? [0] : refundOptional ? [0, 1] : [1];
  return { cases, summaryPosts };
}

/** A stable name for an end, from what it allows. */
export function endName(e: End): string {
  return `r${e.refunds}_c${e.credits}_n${e.notesMax}_y${e.repliesMax}_${e.priority ?? "any"}`;
}

/** The full answer key for a set. Tasks with events (a withdrawn precedent) have no rule yet. */
export function deriveGold(
  set: HeldOutSet,
  meta: { version: number; derivedAt: string; inputs: Gold["inputs"] },
): Gold {
  const ends: Record<string, End> = {};
  const tasks: Gold["tasks"] = {};
  for (const task of set.tasks.tasks) {
    if (task.events.length > 0) throw new Error(`${task.id}: the oracle has no rule for events`);
    const answers = answerTask(set, task);
    const cases: Record<string, CaseGold> = {};
    for (const [key, answer] of answers.cases) {
      for (const e of answer.accept) ends[endName(e)] = e;
      cases[key] = {
        accept: answer.accept.map(endName),
        mustNotApply: answer.mustNotApply,
        ...(answer.signers && { signers: answer.signers }),
        ...(answer.why && { why: answer.why }),
      };
    }
    tasks[task.id] = {
      why: `Derived by oracle v${ORACLE_VERSION} from policy v${set.policy.version}, the set's ops and setup, and this task's perturbations.`,
      summaryPosts: answers.summaryPosts,
      cases,
    };
  }
  return {
    set: set.id,
    version: meta.version,
    split: set.split,
    evidence: "derived",
    authoredAt: meta.derivedAt,
    inputs: meta.inputs,
    ends: Object.fromEntries(Object.entries(ends).sort(([a], [b]) => a.localeCompare(b))),
    tasks,
  };
}
