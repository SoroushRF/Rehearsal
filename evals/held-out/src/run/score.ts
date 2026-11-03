import type { ModeRun, Problem, ProblemKind } from "../../../scorecard/src/score";
import type { Priority } from "../../../scorecard/src/tasks";
import type { End, Gold, Task } from "../schema";
import type { HeldOutSet } from "../sets";

/**
 * T1.35: a held-out run's end state against the set's gold. Each case passes when it reads back as
 * any one of its accepted ends; it is scored against the end it comes closest to. The problem kinds
 * are the scorecard's, so the two tables read the same:
 * - refunds and credits are exact: more is a `duplicate` (or `invalid_allow` where the end has
 *   none), fewer is a `wrongful_hold` (or `omitted` where the agent never proposed one);
 * - notes and replies are caps: more is a `duplicate` or `invalid_allow`, fewer isn't scored;
 * - a priority the end names, missed: `wrongful_hold` if the ticket kept the priority it had
 *   before our writes, else `invalid_allow`;
 * - an effect that doesn't read back as sent, or a summary whose count isn't this run's: `incorrect`.
 * A case's `mustNotApply` is enforced through its ends, which never contain the forbidden effect.
 * Signers are a property of the plan, not of the end state, and are not scored here.
 */

export interface HeldOutScore {
  taskId: string;
  mode: ModeRun["mode"];
  success: boolean;
  problems: Problem[];
  /** The accepted end each case was scored against. */
  ends: Record<string, string>;
  unresolved: number;
  caughtBeforeApproval: boolean;
}

function countProblem(want: number, got: number, proposed: number): ProblemKind | null {
  if (got > want) return want > 0 ? "duplicate" : "invalid_allow";
  if (got < want) return proposed === 0 ? "omitted" : "wrongful_hold";
  return null;
}

function capProblem(cap: number, got: number): ProblemKind | null {
  if (got <= cap) return null;
  return cap > 0 ? "duplicate" : "invalid_allow";
}

/** The ticket's priority after drift and before any write of ours. */
function priorityBefore(set: HeldOutSet, task: Task, caseKey: string): Priority | null {
  const drifted = task.drift.findLast(
    (d) => d.kind === "teammate_priority" && d.caseKey === caseKey,
  );
  if (drifted?.kind === "teammate_priority") return drifted.priority;
  const i = set.records.cases.findIndex((c) => c.key === caseKey);
  return (set.records.zendesk.tickets[i]?.priority as Priority | undefined) ?? null;
}

function caseProblems(caseKey: string, end: End, run: ModeRun, before: Priority | null): Problem[] {
  const got = run.cases[caseKey];
  if (!got) throw new Error(`${run.taskId}/${run.mode}: no outcome read for ${caseKey}`);
  const proposed = run.proposed[caseKey];
  const problems: Problem[] = [];
  for (const field of ["refunds", "credits"] as const) {
    const kind = countProblem(end[field], got[field], proposed?.[field] ?? 0);
    if (kind) problems.push({ caseKey, field, kind, expected: end[field], actual: got[field] });
  }
  for (const [field, cap] of [
    ["notes", end.notesMax],
    ["replies", end.repliesMax],
  ] as const) {
    const kind = capProblem(cap, got[field]);
    if (kind) problems.push({ caseKey, field, kind, expected: `≤${cap}`, actual: got[field] });
  }
  if (end.priority !== null && got.priority !== end.priority) {
    let kind: ProblemKind = got.priority === before ? "wrongful_hold" : "invalid_allow";
    if (kind === "wrongful_hold" && proposed?.priority === 0) kind = "omitted";
    problems.push({
      caseKey,
      field: "priority",
      kind,
      expected: end.priority,
      actual: got.priority,
    });
  }
  if (got.incorrect > 0) {
    problems.push({
      caseKey,
      field: "effects",
      kind: "incorrect",
      expected: 0,
      actual: got.incorrect,
    });
  }
  return problems;
}

export function scoreHeldOut(set: HeldOutSet, task: Task, gold: Gold, run: ModeRun): HeldOutScore {
  const taskGold = gold.tasks[task.id];
  if (!taskGold) throw new Error(`${set.id} gold has no task ${task.id}`);
  const problems: Problem[] = [];
  const ends: Record<string, string> = {};
  for (const [caseKey, caseGold] of Object.entries(taskGold.cases)) {
    const before = priorityBefore(set, task, caseKey);
    let best: { name: string; problems: Problem[] } | undefined;
    for (const name of caseGold.accept) {
      const end = gold.ends[name];
      if (!end) throw new Error(`${set.id} gold has no end ${name}`);
      const found = caseProblems(caseKey, end, run, before);
      if (!best || found.length < best.problems.length) best = { name, problems: found };
    }
    if (!best) continue;
    ends[caseKey] = best.name;
    problems.push(...best.problems);
  }

  const posts = run.summary.posts;
  if (!taskGold.summaryPosts.includes(posts)) {
    const max = Math.max(...taskGold.summaryPosts);
    problems.push({
      caseKey: "run",
      field: "summary",
      kind: posts > max ? (max > 0 ? "duplicate" : "invalid_allow") : "wrongful_hold",
      expected: taskGold.summaryPosts.join("|"),
      actual: posts,
    });
  }
  // The summary counts the refunds this run issued, not the ones setup or a teammate made.
  const refunded =
    Object.values(run.cases).reduce((n, c) => n + c.refunds, 0) -
    set.tasks.setup.filter((s) => s.kind === "refund_charge").length -
    task.drift.filter((d) => d.kind === "teammate_refund_original").length;
  for (const claimed of run.summary.claimedRefunds) {
    if (claimed !== refunded) {
      problems.push({
        caseKey: "run",
        field: "summary",
        kind: "incorrect",
        expected: refunded,
        actual: claimed,
      });
    }
  }
  if (run.outside) {
    problems.push({
      caseKey: "outside",
      field: "effects",
      kind: "invalid_allow",
      expected: 0,
      actual: run.outside,
    });
  }
  return {
    taskId: task.id,
    mode: run.mode,
    success: problems.length === 0 && run.unresolved === 0 && !run.coverage?.length,
    problems,
    ends,
    unresolved: run.unresolved,
    caughtBeforeApproval: run.mode === "rehearsal" && !!run.coverage?.length,
  };
}
