import { describe, expect, it } from "vitest";
import {
  compareConcurrency,
  formatConcurrency,
  parseResults,
  type ResultsFile,
} from "../src/concurrency";
import { type CaseOutcome, type ModeRun, median, summarize } from "../src/score";
import { type CaseKey, type ScorecardTask, TASKS } from "../src/tasks";

const byId = (id: string) => {
  const task = TASKS.find((t) => t.id === id);
  if (!task) throw new Error(`no task ${id}`);
  return task;
};

/** A run whose end state is exactly the task's gold, with overrides per case. */
function runOf(
  task: ScorecardTask,
  mode: ModeRun["mode"],
  extra: Partial<ModeRun> = {},
  override: Record<CaseKey, Partial<CaseOutcome>> = {},
): ModeRun {
  const cases: Record<CaseKey, CaseOutcome> = {};
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
    refunded += gold.refunds;
  }
  const all = { refunds: 1, credits: 1, priority: 1, notes: 1, replies: 1 };
  return {
    taskId: task.id,
    mode,
    cases,
    proposed: Object.fromEntries(Object.keys(task.gold).map((k) => [k, all])),
    summary: {
      posts: task.summaryPosts,
      claimedRefunds: Array.from({ length: task.summaryPosts }, () => refunded),
    },
    unresolved: 0,
    reviewerActions: 0,
    promptOpportunities: 0,
    latencyMs: 0,
    eraCalls: 0,
    ...extra,
  };
}

const B1 = byId("B1");
const B2 = byId("B2");
const T1 = byId("T1");

function results(caseConcurrency: number | undefined, runs: ModeRun[]): ResultsFile {
  return {
    file: `c${caseConcurrency ?? "old"}.json`,
    ...(caseConcurrency !== undefined && { caseConcurrency }),
    commit: "34b77da",
    runs,
  };
}

describe("median", () => {
  it("takes the middle value, or the mean of the middle two", () => {
    expect(median([])).toBe(0);
    expect(median([5])).toBe(5);
    expect(median([300, 100, 200])).toBe(200);
    expect(median([400, 100, 300, 200])).toBe(250);
  });

  it("is on the scorecard summary for each mode", () => {
    const runs = [
      runOf(B1, "rehearsal", { latencyMs: 100 }),
      runOf(B2, "rehearsal", { latencyMs: 900 }),
      runOf(T1, "rehearsal", { latencyMs: 200 }),
    ];
    const rehearsal = summarize([B1, B2, T1], runs).find((s) => s.mode === "rehearsal");
    expect(rehearsal).toMatchObject({ latencyMs: 1200, medianLatencyMs: 200 });
  });
});

describe("compareConcurrency (T1.33)", () => {
  it("gives the total, median and Era calls of each mode at each setting", () => {
    const at1 = results(1, [
      runOf(B1, "rehearsal", { latencyMs: 600, eraCalls: 100 }),
      runOf(B2, "rehearsal", { latencyMs: 400, eraCalls: 90 }),
      runOf(B1, "direct", { latencyMs: 300, eraCalls: 30 }),
      runOf(B2, "direct", { latencyMs: 300, eraCalls: 30 }),
    ]);
    const at4 = results(4, [
      runOf(B1, "rehearsal", { latencyMs: 200, eraCalls: 100 }),
      runOf(B2, "rehearsal", { latencyMs: 150, eraCalls: 90 }),
      runOf(B1, "direct", { latencyMs: 310, eraCalls: 30 }),
      runOf(B2, "direct", { latencyMs: 290, eraCalls: 30 }),
    ]);
    const report = compareConcurrency(at1, at4);
    expect(report.warnings).toEqual([]);
    expect(report.differences).toEqual([]);
    expect(report.modes.map((m) => m.mode)).toEqual(["direct", "rehearsal"]);
    expect(report.modes.find((m) => m.mode === "rehearsal")).toEqual({
      mode: "rehearsal",
      a: { latencyMs: 1000, medianLatencyMs: 500, eraCalls: 190, success: 2 },
      b: { latencyMs: 350, medianLatencyMs: 175, eraCalls: 190, success: 2 },
    });

    const text = formatConcurrency(report);
    expect(text).toMatch(/^Write phase \(s\), concurrency 4\s+\| 0\.6\s+\| 0\.3$/m);
    expect(text).toMatch(/^Median task \(s\), concurrency 1\s+\| 0\.30\s+\| 0\.50$/m);
    expect(text).toContain("Outcome differences: none.");
  });

  it("lists every task whose result differs between the two runs", () => {
    const at1 = results(1, [runOf(B1, "rehearsal"), runOf(T1, "rehearsal")]);
    const at4 = results(4, [
      runOf(B1, "rehearsal", {}, { c01: { refunds: 0, notes: 0 } }),
      runOf(T1, "rehearsal"),
    ]);
    const report = compareConcurrency(at1, at4);
    expect(report.differences).toEqual([
      { taskId: "B1", mode: "rehearsal", a: "ok", b: expect.stringContaining("HOLD c01.refunds") },
    ]);
    expect(formatConcurrency(report)).toContain("Outcome differences: 1.");
  });

  it("compares only tasks both files ran, and warns about mismatched runs", () => {
    const old = results(undefined, [runOf(B1, "rehearsal"), runOf(B2, "rehearsal")]);
    const again = { ...results(undefined, [runOf(B1, "rehearsal")]), commit: "abc1234" };
    const report = compareConcurrency(old, {
      ...again,
      runs: [...again.runs, { ...runOf(B1, "rehearsal"), taskId: "Z9" }],
    });
    expect(report.tasks.map((t) => t.id)).toEqual(["B1"]);
    expect(report.onlyIn).toEqual({ a: ["B2"], b: [] });
    expect(report.warnings).toEqual([
      "not in today's catalog, left out: Z9",
      "the runs are on different commits: 34b77da and abc1234",
      "both runs used case concurrency 1",
    ]);
    expect(formatConcurrency(report)).toContain("concurrency 1 (not recorded)");
  });

  it("reads a results file and refuses one with no runs", () => {
    const parsed = parseResults(
      "dir/c4.json",
      JSON.stringify({ caseConcurrency: 4, commit: "x", runs: [runOf(B1, "direct")], details: [] }),
    );
    expect(parsed).toMatchObject({ file: "c4.json", caseConcurrency: 4, commit: "x" });
    expect(() => parseResults("latest.txt", "{}")).toThrow(/no runs/);
  });
});
