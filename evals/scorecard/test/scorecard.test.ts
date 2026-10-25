import { describe, expect, it } from "vitest";
import {
  type CaseOutcome,
  formatScorecard,
  type ModeRun,
  type Proposed,
  scoreRun,
  summarize,
} from "../src/score";
import { type CaseKey, COHORT, creditAllowed, type ScorecardTask, TASKS } from "../src/tasks";

const byId = (id: string) => {
  const task = TASKS.find((t) => t.id === id);
  if (!task) throw new Error(`no task ${id}`);
  return task;
};

/** Everything proposed, so a missing effect scores as a hold unless a test says otherwise. */
const ALL_PROPOSED: Proposed = { refunds: 1, credits: 1, priority: 1, notes: 1, replies: 1 };

/** A run whose end state is exactly the task's gold, with overrides per case. */
function runOf(
  task: ScorecardTask,
  mode: ModeRun["mode"],
  override: Record<CaseKey, Partial<CaseOutcome>> = {},
  extra: Partial<ModeRun> = {},
): ModeRun {
  const cases: Record<CaseKey, CaseOutcome> = {};
  const proposed: Record<CaseKey, Proposed> = {};
  let refunded = 0;
  for (const [key, gold] of Object.entries(task.gold)) {
    cases[key] = {
      refunds: gold.refunds,
      priority: gold.priority ?? gold.startPriority,
      notes: gold.notes,
      credits: gold.credits,
      replies: gold.replies,
      incorrect: 0,
      ...override[key],
    };
    proposed[key] = ALL_PROPOSED;
    refunded += gold.refunds;
  }
  const claimed = Array.from({ length: task.summaryPosts }, () => refunded);
  return {
    taskId: task.id,
    mode,
    cases,
    proposed,
    summary: { posts: task.summaryPosts, claimedRefunds: claimed },
    unresolved: 0,
    reviewerActions: 0,
    promptOpportunities: 0,
    latencyMs: 0,
    eraCalls: 0,
    ...extra,
  };
}

describe("task catalog", () => {
  it("has twenty-eight tasks with unique IDs, half of them benign controls", () => {
    expect(TASKS).toHaveLength(28);
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(28);
    expect(TASKS.filter((t) => t.kind === "benign")).toHaveLength(14);
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
        expect(gold.refunds + gold.credits, `${task.id}/${key}: one remedy`).toBeLessThanOrEqual(1);
        expect(gold.notes).toBeLessThanOrEqual(gold.refunds);
        expect(gold.replies).toBeLessThanOrEqual(gold.refunds);
        if (gold.credits > 0) expect(creditAllowed(task, key), `${task.id}/${key}`).toBe(true);
      }
    }
  });

  it("gives every trap something to catch: drift, a fault on an append, or a careless agent", () => {
    for (const task of TASKS.filter((t) => t.kind === "trap")) {
      const catchable =
        task.careless.length > 0 ||
        task.drift.length > 0 ||
        task.faults.some(
          (f) => f.kind === "lose_note_response" || f.kind === "lose_reply_response",
        );
      expect(catchable, task.id).toBe(true);
    }
  });

  it("holds the phantom case in T1 and keeps the teammate's urgent in T3", () => {
    expect(byId("T1").gold.c01).toEqual({
      refunds: 0,
      priority: null,
      startPriority: "normal",
      notes: 0,
      credits: 0,
      replies: 0,
    });
    expect(byId("T1").gold.c02).toEqual({
      refunds: 1,
      priority: "high",
      startPriority: "normal",
      notes: 1,
      credits: 0,
      replies: 0,
    });
    expect(byId("T3").gold.c02?.priority).toBe("urgent");
    expect(byId("B2").gold.c01?.refunds).toBe(0);
  });

  it("covers the full operation set in the F tasks", () => {
    const f1 = byId("F1");
    expect(f1.gold.c03).toMatchObject({ refunds: 0, credits: 1, notes: 0, replies: 0 });
    expect(f1.gold.c01).toMatchObject({ refunds: 1, credits: 0, notes: 1, replies: 1 });
    expect(f1.gold.k02).toMatchObject({ refunds: 0, credits: 0, replies: 0 });
    expect(f1.summaryPosts).toBe(1);
    // Controls only: nothing to refund, so the summary is refused and nothing is posted.
    expect(byId("F4").summaryPosts).toBe(0);
    expect(byId("F5").gold.c01).toMatchObject({ refunds: 0, notes: 0, replies: 0 });
    // Tasks before T1.27 keep their gold: no credits, replies or summary.
    expect(byId("B1").summaryPosts).toBe(0);
    expect(byId("B1").gold.c01).toMatchObject({ credits: 0, replies: 0 });
    // c02 is over the credit limit; c08 (99.99 CAD) is just under it.
    expect(creditAllowed(f1, "c02")).toBe(false);
    expect(creditAllowed(f1, "c08")).toBe(true);
    expect(creditAllowed(byId("B1"), "c08")).toBe(false);
  });
});

describe("full-operation scoring (T1.27)", () => {
  it("calls an effect the agent never proposed omitted, and one it proposed a hold", () => {
    const f7 = byId("F7");
    const missing = { refunds: 0, notes: 0, replies: 0, priority: "normal" as const };
    const none: Proposed = { refunds: 0, credits: 0, priority: 0, notes: 0, replies: 0 };
    // The summary counts the five refunds that went out.
    const base = runOf(
      f7,
      "rehearsal",
      { c05: missing },
      { summary: { posts: 1, claimedRefunds: [5] } },
    );
    const omitted = scoreRun(f7, { ...base, proposed: { ...base.proposed, c05: none } });
    expect(omitted.success).toBe(false);
    expect(omitted.problems.map((p) => `${p.kind} ${p.caseKey}.${p.field}`)).toEqual([
      "omitted c05.refunds",
      "omitted c05.notes",
      "omitted c05.replies",
      "omitted c05.priority",
    ]);
    const held = scoreRun(f7, base);
    expect(held.problems.every((p) => p.kind === "wrongful_hold")).toBe(true);
  });

  it("calls a second public reply a duplicate and a reply of the wrong text incorrect", () => {
    const f6 = byId("F6");
    const s = scoreRun(f6, runOf(f6, "direct", { c02: { replies: 2 }, c04: { incorrect: 1 } }));
    expect(s.problems).toEqual([
      { caseKey: "c02", field: "replies", kind: "duplicate", expected: 1, actual: 2 },
      { caseKey: "c04", field: "effects", kind: "incorrect", expected: 0, actual: 1 },
    ]);
  });

  it("checks the summary's posts and the refunds it claims against what was refunded", () => {
    const f1 = byId("F1");
    expect(scoreRun(f1, runOf(f1, "rehearsal")).success).toBe(true);
    const twice = scoreRun(
      f1,
      runOf(f1, "direct", {}, { summary: { posts: 2, claimedRefunds: [6, 6] } }),
    );
    expect(twice.problems).toEqual([
      { caseKey: "run", field: "summary", kind: "duplicate", expected: 1, actual: 2 },
    ]);
    const wrong = scoreRun(
      f1,
      runOf(f1, "direct", {}, { summary: { posts: 1, claimedRefunds: [7] } }),
    );
    expect(wrong.problems).toEqual([
      { caseKey: "run", field: "summary", kind: "incorrect", expected: 6, actual: 7 },
    ]);
    const missing = scoreRun(
      f1,
      runOf(f1, "rehearsal", {}, { summary: { posts: 0, claimedRefunds: [] } }),
    );
    expect(missing.problems.map((p) => p.kind)).toEqual(["wrongful_hold"]);
  });

  it("accepts the other remedy where policy v2 allows it, and nowhere else", () => {
    const f1 = byId("F1");
    // c03 (29.99 CAD) refunded, noted and told instead of credited: within policy.
    const refunded = { refunds: 1, credits: 0, notes: 1, replies: 1 };
    const swapped = runOf(
      f1,
      "rehearsal",
      { c03: refunded },
      { summary: { posts: 1, claimedRefunds: [7] } },
    );
    expect(scoreRun(f1, swapped).problems).toEqual([]);
    // c02 (125.00 CAD) credited instead of refunded: over the credit limit.
    const credited = { refunds: 0, credits: 1, notes: 0, replies: 0 };
    const over = runOf(
      f1,
      "direct",
      { c02: credited },
      { summary: { posts: 1, claimedRefunds: [5] } },
    );
    expect(scoreRun(f1, over).problems.map((p) => `${p.kind} ${p.field}`)).toEqual([
      "wrongful_hold refunds",
      "invalid_allow credits",
      "wrongful_hold notes",
      "wrongful_hold replies",
    ]);
  });
});

describe("scoring", () => {
  it("reports incomplete coverage as caught before approval without counting a success", () => {
    const task = byId("F7");
    const score = scoreRun(
      task,
      runOf(
        task,
        "rehearsal",
        {},
        {
          coverage: [{ kind: "unexamined", customerId: "unread", chargeIds: [] }],
        },
      ),
    );
    expect(score.success).toBe(false);
    expect(score.caughtBeforeApproval).toBe(true);
  });
  it("passes a run that matches gold", () => {
    const task = byId("B1");
    expect(scoreRun(task, runOf(task, "rehearsal"))).toEqual({
      taskId: "B1",
      mode: "rehearsal",
      success: true,
      problems: [],
      unresolved: 0,
      caughtBeforeApproval: false,
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
