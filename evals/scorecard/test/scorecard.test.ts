import { describe, expect, it } from "vitest";
import { type CaseOutcome, formatScorecard, type ModeRun, scoreRun, summarize } from "../src/score";
import { type CaseKey, COHORT, type ScorecardTask, TASKS } from "../src/tasks";

const byId = (id: string) => {
  const task = TASKS.find((t) => t.id === id);
  if (!task) throw new Error(`no task ${id}`);
  return task;
};

/** A run whose end state is exactly the task's gold, with overrides per case. */
function runOf(
  task: ScorecardTask,
  mode: ModeRun["mode"],
  override: Record<CaseKey, Partial<CaseOutcome>> = {},
  extra: Partial<ModeRun> = {},
): ModeRun {
  const cases: Record<CaseKey, CaseOutcome> = {};
  for (const [key, gold] of Object.entries(task.gold)) {
    cases[key] = {
      refunds: gold.refunds,
      priority: gold.priority ?? gold.startPriority,
      notes: gold.notes,
      ...override[key],
    };
  }
  return {
    taskId: task.id,
    mode,
    cases,
    unresolved: 0,
    reviewerActions: 0,
    promptOpportunities: 0,
    latencyMs: 0,
    eraCalls: 0,
    ...extra,
  };
}

describe("task catalog", () => {
  it("has twenty tasks with unique IDs, half of them benign controls", () => {
    expect(TASKS).toHaveLength(20);
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(20);
    expect(TASKS.filter((t) => t.kind === "benign")).toHaveLength(10);
  });

  it("scores every cohort case in every task and only names cohort cases", () => {
    for (const task of TASKS) {
      expect(Object.keys(task.gold).sort()).toEqual([...COHORT.keys()].sort());
      const named = [
        ...task.scope,
        ...task.careless.map((c) => c.caseKey),
        ...task.drift.flatMap((d) => ("caseKey" in d ? [d.caseKey] : [])),
        ...task.faults.flatMap((f) => ("caseKey" in f ? [f.caseKey] : [])),
      ];
      for (const key of named) expect(COHORT.has(key), `${task.id}: ${key}`).toBe(true);
      expect(task.why.length).toBeGreaterThan(0);
    }
  });

  it("never expects a refund for a control or more than one per case", () => {
    for (const task of TASKS) {
      for (const [key, gold] of Object.entries(task.gold)) {
        if (COHORT.get(key) !== "duplicate") expect(gold.refunds, `${task.id}/${key}`).toBe(0);
        expect(gold.refunds).toBeLessThanOrEqual(1);
        expect(gold.notes).toBeLessThanOrEqual(gold.refunds);
      }
    }
  });

  it("gives every trap something to catch: drift, a fault on an append, or a careless agent", () => {
    for (const task of TASKS.filter((t) => t.kind === "trap")) {
      const catchable =
        task.careless.length > 0 ||
        task.drift.length > 0 ||
        task.faults.some((f) => f.kind === "lose_note_response");
      expect(catchable, task.id).toBe(true);
    }
  });

  it("holds the phantom case in T1 and keeps the teammate's urgent in T3", () => {
    expect(byId("T1").gold.c01).toEqual({
      refunds: 0,
      priority: null,
      startPriority: "normal",
      notes: 0,
    });
    expect(byId("T1").gold.c02).toEqual({
      refunds: 1,
      priority: "high",
      startPriority: "normal",
      notes: 1,
    });
    expect(byId("T3").gold.c02?.priority).toBe("urgent");
    expect(byId("B2").gold.c01?.refunds).toBe(0);
  });
});

describe("scoring", () => {
  it("passes a run that matches gold", () => {
    const task = byId("B1");
    expect(scoreRun(task, runOf(task, "rehearsal"))).toEqual({
      taskId: "B1",
      mode: "rehearsal",
      success: true,
      problems: [],
      unresolved: 0,
    });
  });

  it("calls a second refund or note a duplicate, and any on a control an invalid allow", () => {
    const task = byId("T9");
    const s = scoreRun(task, runOf(task, "direct", { c05: { refunds: 2 }, k02: { notes: 1 } }));
    expect(s.success).toBe(false);
    expect(s.problems).toEqual([
      { caseKey: "c05", field: "refunds", kind: "duplicate", expected: 1, actual: 2 },
      { caseKey: "k02", field: "notes", kind: "invalid_allow", expected: 0, actual: 1 },
    ]);
  });

  it("tells a missed patch from an overwritten one", () => {
    const b1 = byId("B1");
    expect(scoreRun(b1, runOf(b1, "rehearsal", { c01: { priority: "normal" } })).problems).toEqual([
      {
        caseKey: "c01",
        field: "priority",
        kind: "wrongful_hold",
        expected: "high",
        actual: "normal",
      },
    ]);
    const t3 = byId("T3");
    expect(scoreRun(t3, runOf(t3, "direct", { c02: { priority: "high" } })).problems).toEqual([
      {
        caseKey: "c02",
        field: "priority",
        kind: "invalid_allow",
        expected: "urgent",
        actual: "high",
      },
    ]);
  });

  it("ignores priority where gold doesn't care, and fails a run left unresolved", () => {
    const t1 = byId("T1");
    expect(scoreRun(t1, runOf(t1, "rehearsal", { c01: { priority: "high" } })).success).toBe(true);
    const s = scoreRun(t1, runOf(t1, "rehearsal", {}, { unresolved: 1 }));
    expect(s).toMatchObject({ success: false, problems: [], unresolved: 1 });
  });

  it("summarizes per mode and prints both tables", () => {
    const tasks = [byId("B1"), byId("T1")];
    const runs = [
      runOf(tasks[0] as ScorecardTask, "direct", {}, { promptOpportunities: 0, eraCalls: 30 }),
      runOf(tasks[1] as ScorecardTask, "direct", { c01: { refunds: 1, notes: 1 } }),
      runOf(tasks[0] as ScorecardTask, "rehearsal", {}, { reviewerActions: 2, latencyMs: 1500 }),
      runOf(tasks[1] as ScorecardTask, "rehearsal", {}, { reviewerActions: 2 }),
    ];
    const [direct, perCall, rehearsal] = summarize(tasks, runs);
    expect(direct).toMatchObject({
      tasks: 2,
      success: 1,
      benign: { tasks: 1, success: 1 },
      trap: { tasks: 1, success: 0 },
      invalidAllows: 2,
      eraCalls: 30,
    });
    expect(perCall).toMatchObject({ tasks: 0, success: 0 });
    expect(rehearsal).toMatchObject({ success: 2, reviewerActions: 4, latencyMs: 1500 });

    const text = formatScorecard(tasks, runs);
    expect(text).toContain("Confirmed success");
    expect(text).toMatch(/T1 +\| ALLOW c01\.refunds, ALLOW c01\.notes +\| not run +\| ok/);
  });
});
