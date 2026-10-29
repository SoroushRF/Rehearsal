import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MODE_LABEL,
  MODES,
  type Mode,
  type ModeRun,
  scoreLabel,
  scoreRun,
  summarize,
  table,
} from "./score";
import { type ScorecardTask, TASKS } from "./tasks";

/**
 * T1.33: compare two scorecard results files that differ only in the executor's case concurrency
 * (`--concurrency 1` and `--concurrency 4`). For each mode it gives the total write phase, the
 * median task and the Era calls, then every task whose result differs between the two runs.
 * Both files are scored again with today's scorer, so they're compared on the same rules.
 *   tsx evals/scorecard/src/concurrency.ts results/c1.json results/c4.json [--out report.txt]
 */

export interface ResultsFile {
  file: string;
  /** Absent in files written before T1.33, which all ran one case at a time. */
  caseConcurrency?: number;
  commit?: string;
  ranAt?: string;
  runs: ModeRun[];
}

export interface Difference {
  taskId: string;
  mode: Mode;
  a: string;
  b: string;
}

export interface ConcurrencyReport {
  a: ResultsFile;
  b: ResultsFile;
  /** The tasks both files ran. A task only one file ran is listed apart, never compared. */
  tasks: ScorecardTask[];
  onlyIn: { a: string[]; b: string[] };
  modes: {
    mode: Mode;
    a: { latencyMs: number; medianLatencyMs: number; eraCalls: number; success: number };
    b: { latencyMs: number; medianLatencyMs: number; eraCalls: number; success: number };
  }[];
  differences: Difference[];
  warnings: string[];
}

export function parseResults(file: string, text: string): ResultsFile {
  const json = JSON.parse(text) as Partial<ResultsFile>;
  if (!Array.isArray(json.runs)) throw new Error(`${file}: no runs (is it a scorecard .json?)`);
  return {
    file: basename(file),
    ...(json.caseConcurrency !== undefined && { caseConcurrency: json.caseConcurrency }),
    ...(json.commit !== undefined && { commit: json.commit }),
    ...(json.ranAt !== undefined && { ranAt: json.ranAt }),
    runs: json.runs,
  };
}

export function compareConcurrency(
  a: ResultsFile,
  b: ResultsFile,
  catalog: readonly ScorecardTask[] = TASKS,
): ConcurrencyReport {
  const idsOf = (r: ResultsFile) => new Set(r.runs.map((run) => run.taskId));
  const inA = idsOf(a);
  const inB = idsOf(b);
  const tasks = catalog.filter((t) => inA.has(t.id) && inB.has(t.id));
  const shared = new Set(tasks.map((t) => t.id));
  const unknown = [...new Set([...inA, ...inB])].filter((id) => !catalog.some((t) => t.id === id));
  const runsOf = (r: ResultsFile) => r.runs.filter((run) => shared.has(run.taskId));

  const warnings: string[] = [];
  if (unknown.length) warnings.push(`not in today's catalog, left out: ${unknown.join(", ")}`);
  if (a.commit !== b.commit) {
    warnings.push(
      `the runs are on different commits: ${a.commit ?? "unrecorded"} and ${b.commit ?? "unrecorded"}`,
    );
  }
  if ((a.caseConcurrency ?? 1) === (b.caseConcurrency ?? 1)) {
    warnings.push(`both runs used case concurrency ${a.caseConcurrency ?? 1}`);
  }

  const summaryA = summarize(tasks, runsOf(a));
  const summaryB = summarize(tasks, runsOf(b));
  const pick = (s: (typeof summaryA)[number] | undefined) => ({
    latencyMs: s?.latencyMs ?? 0,
    medianLatencyMs: s?.medianLatencyMs ?? 0,
    eraCalls: s?.eraCalls ?? 0,
    success: s?.success ?? 0,
  });
  const modes = MODES.filter(
    (m) => runsOf(a).some((r) => r.mode === m) || runsOf(b).some((r) => r.mode === m),
  ).map((mode) => ({
    mode,
    a: pick(summaryA.find((s) => s.mode === mode)),
    b: pick(summaryB.find((s) => s.mode === mode)),
  }));

  const labelOf = (r: ResultsFile, task: ScorecardTask, mode: Mode) => {
    const run = r.runs.find((x) => x.taskId === task.id && x.mode === mode);
    return scoreLabel(run && scoreRun(task, run));
  };
  const differences: Difference[] = [];
  for (const task of tasks) {
    for (const { mode } of modes) {
      const left = labelOf(a, task, mode);
      const right = labelOf(b, task, mode);
      if (left !== right) differences.push({ taskId: task.id, mode, a: left, b: right });
    }
  }

  return {
    a,
    b,
    tasks,
    onlyIn: {
      a: [...inA].filter((id) => !inB.has(id) && !unknown.includes(id)).sort(),
      b: [...inB].filter((id) => !inA.has(id) && !unknown.includes(id)).sort(),
    },
    modes,
    differences,
    warnings,
  };
}

export function formatConcurrency(r: ConcurrencyReport): string {
  const at = (f: ResultsFile) => `concurrency ${f.caseConcurrency ?? "1 (not recorded)"}`;
  const s = (ms: number, digits: number) => (ms / 1000).toFixed(digits);
  const rows: [string, ...string[]][] = [
    ["", ...r.modes.map((m) => MODE_LABEL[m.mode])],
    [`Write phase (s), ${at(r.a)}`, ...r.modes.map((m) => s(m.a.latencyMs, 1))],
    [`Write phase (s), ${at(r.b)}`, ...r.modes.map((m) => s(m.b.latencyMs, 1))],
    [`Median task (s), ${at(r.a)}`, ...r.modes.map((m) => s(m.a.medianLatencyMs, 2))],
    [`Median task (s), ${at(r.b)}`, ...r.modes.map((m) => s(m.b.medianLatencyMs, 2))],
    [`Era calls, ${at(r.a)}`, ...r.modes.map((m) => String(m.a.eraCalls))],
    [`Era calls, ${at(r.b)}`, ...r.modes.map((m) => String(m.b.eraCalls))],
    [`Confirmed success, ${at(r.a)}`, ...r.modes.map((m) => `${m.a.success}/${r.tasks.length}`)],
    [`Confirmed success, ${at(r.b)}`, ...r.modes.map((m) => `${m.b.success}/${r.tasks.length}`)],
  ];
  const out = [
    "T1.33: executor case concurrency",
    `  A: ${r.a.file}, ${at(r.a)}, commit ${r.a.commit ?? "unrecorded"}${r.a.ranAt ? `, ran ${r.a.ranAt}` : ""}`,
    `  B: ${r.b.file}, ${at(r.b)}, commit ${r.b.commit ?? "unrecorded"}${r.b.ranAt ? `, ran ${r.b.ranAt}` : ""}`,
    `  ${r.tasks.length} tasks in both files, scored again with today's scorer`,
    ...r.warnings.map((w) => `  warning: ${w}`),
    ...(r.onlyIn.a.length ? [`  only in A, not compared: ${r.onlyIn.a.join(", ")}`] : []),
    ...(r.onlyIn.b.length ? [`  only in B, not compared: ${r.onlyIn.b.join(", ")}`] : []),
    "",
    table(rows),
    "Only the Rehearsal mode runs the executor, so only its cases run at once; the baselines send one",
    "  call at a time in both files. Their differences are run-to-run noise.",
    "",
  ];
  if (r.differences.length === 0) {
    out.push("Outcome differences: none. Every task has the same result in both runs.");
  } else {
    out.push(
      `Outcome differences: ${r.differences.length}. Each needs an explanation in the report.`,
    );
    out.push(
      table([
        ["Task", "Mode", at(r.a), at(r.b)],
        ...r.differences.map((d) => [d.taskId, MODE_LABEL[d.mode], d.a, d.b]),
      ]),
    );
  }
  return out.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const outAt = args.indexOf("--out");
  const out = outAt >= 0 ? args[outAt + 1] : undefined;
  const files = outAt >= 0 ? [...args.slice(0, outAt), ...args.slice(outAt + 2)] : args;
  const [first, second] = files;
  if (files.length !== 2 || !first || !second) {
    console.error(
      "usage: concurrency.ts <results at 1>.json <results at 4>.json [--out report.txt]",
    );
    process.exit(1);
  }
  const report = formatConcurrency(
    compareConcurrency(
      parseResults(first, readFileSync(first, "utf8")),
      parseResults(second, readFileSync(second, "utf8")),
    ),
  );
  console.log(report);
  if (out) writeFileSync(out, `${report}\n`);
}
