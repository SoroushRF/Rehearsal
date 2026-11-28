import { describe, expect, it } from "vitest";
import type { CaseOutcome, ModeRun } from "../../scorecard/src/score";
import { loadGold } from "../src/gold";
import { scoreHeldOut } from "../src/run/score";
import { loadSet } from "../src/sets";

/** T1.35: the runner's scoring against a set's gold, on outcomes built from the gold itself. */

const set = loadSet("ho1");
const gold = loadGold("ho1");
const task = set.tasks.tasks[0];
if (!task) throw new Error("ho1 has no tasks");
const taskGold = gold.tasks[task.id];
if (!taskGold) throw new Error(`no gold for ${task.id}`);

/** A run whose every case reads back as its first accepted end. */
function perfectRun(): ModeRun {
  const cases: Record<string, CaseOutcome> = {};
  for (const [key, g] of Object.entries(taskGold?.cases ?? {})) {
    const end = gold.ends[g.accept[0] ?? ""];
    if (!end) throw new Error(`no end for ${key}`);
    cases[key] = {
      refunds: end.refunds,
      credits: end.credits,
      notes: end.notesMax,
      replies: end.repliesMax,
      priority: end.priority ?? "normal",
      incorrect: 0,
    };
  }
  const proposed = Object.fromEntries(
    Object.keys(cases).map((k) => [
      k,
      { refunds: 1, credits: 1, priority: 1, notes: 1, replies: 1 },
    ]),
  );
  return {
    taskId: task?.id ?? "",
    mode: "rehearsal",
    cases,
    proposed,
    summary: { posts: taskGold?.summaryPosts[0] ?? 0, claimedRefunds: [] },
    unresolved: 0,
    reviewerActions: 1,
    promptOpportunities: 1,
    latencyMs: 0,
    eraCalls: 0,
    outside: 0,
  };
}

describe("held-out scoring", () => {
  it("passes a run that reads back as an accepted end in every case", () => {
    const score = scoreHeldOut(set, task, gold, perfectRun());
    expect(score.problems).toEqual([]);
    expect(score.success).toBe(true);
    expect(Object.keys(score.ends)).toEqual(Object.keys(taskGold.cases));
  });

  it("scores an extra refund as a duplicate and a missing one as a hold or an omission", () => {
    const [key, g] = Object.entries(taskGold.cases).find(
      ([, c]) => gold.ends[c.accept[0] ?? ""]?.refunds === 1 && c.accept.length === 1,
    ) ?? ["", undefined];
    expect(g).toBeDefined();
    const extra = perfectRun();
    (extra.cases[key] as CaseOutcome).refunds = 2;
    expect(scoreHeldOut(set, task, gold, extra).problems).toContainEqual(
      expect.objectContaining({ caseKey: key, field: "refunds", kind: "duplicate" }),
    );
    const held = perfectRun();
    (held.cases[key] as CaseOutcome).refunds = 0;
    expect(scoreHeldOut(set, task, gold, held).problems).toContainEqual(
      expect.objectContaining({ caseKey: key, field: "refunds", kind: "wrongful_hold" }),
    );
    held.proposed[key] = { refunds: 0, credits: 0, priority: 0, notes: 0, replies: 0 };
    expect(scoreHeldOut(set, task, gold, held).problems).toContainEqual(
      expect.objectContaining({ caseKey: key, field: "refunds", kind: "omitted" }),
    );
  });

  it("takes any accepted end, and reports the one it matched", () => {
    const [key, g] = Object.entries(taskGold.cases).find(([, c]) => c.accept.length > 1) ?? [
      "",
      undefined,
    ];
    const second = gold.ends[g?.accept[1] ?? ""];
    if (!second) throw new Error("no case with two accepted ends");
    const run = perfectRun();
    run.cases[key] = {
      refunds: second.refunds,
      credits: second.credits,
      notes: second.notesMax,
      replies: second.repliesMax,
      priority: second.priority ?? "normal",
      incorrect: 0,
    };
    const score = scoreHeldOut(set, task, gold, run);
    expect(score.success).toBe(true);
    expect(score.ends[key]).toBe(g?.accept[1]);
  });

  it("fails a summary that claims another refund count, and effects outside the key", () => {
    const run = perfectRun();
    run.summary.claimedRefunds = [999];
    run.outside = 1;
    const kinds = scoreHeldOut(set, task, gold, run).problems.map((p) => `${p.caseKey}.${p.kind}`);
    expect(kinds).toEqual(expect.arrayContaining(["run.incorrect", "outside.invalid_allow"]));
  });
});
