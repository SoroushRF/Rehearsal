import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { MODE_LABEL, MODES, type Mode } from "./score";

/**
 * T1.31: rescore a results file written before the scorer knew about planner failures. Only the
 * text file was kept, so this works from its summary table, its per-task rows and its model panel:
 * a task whose plan failed loses its "ok" and its HOLD/OMIT codes, and is counted as a planner
 * failure instead. Effects outside the answer key can't be rescored: old runs never read them.
 *   tsx evals/scorecard/src/rescore.ts evals/scorecard/results/model-gemini-4-argon.txt …
 */

export interface ModeCounts {
  success: number;
  tasks: number;
  wrongfulHolds: number;
  omitted: number;
}

export interface Rescored {
  file: string;
  failed: { taskId: string; error: string }[];
  /** The modes the file has, in its column order (older files have no competent script). */
  modes: Mode[];
  before: Partial<Record<Mode, ModeCounts>>;
  after: Partial<Record<Mode, ModeCounts & { plannerFailures: number; planned: number }>>;
}

const cells = (line: string) => line.split(" | ").map((c) => c.trim());

export function rescore(file: string, text: string): Rescored {
  const lines = text.split("\n");
  const header = lines.find((l) => cells(l)[0] === "Task");
  if (!header) throw new Error(`${file}: no task table`);
  const modes = MODES.filter((m) => cells(header).includes(MODE_LABEL[m])).sort(
    (a, b) => cells(header).indexOf(MODE_LABEL[a]) - cells(header).indexOf(MODE_LABEL[b]),
  );
  const row = (label: string, optional = false) => {
    const line = lines.find((l) => cells(l)[0] === label);
    if (!line && !optional) throw new Error(`${file}: no "${label}" row`);
    // Files from before T1.27 have no omitted row: those counts read as 0 and stay 0.
    return line ? cells(line).slice(1, 1 + modes.length) : modes.map(() => "0");
  };
  const success = row("Confirmed success");
  const holds = row("Wrongful holds");
  const omitted = row("Omitted obligations", true);
  const before = Object.fromEntries(
    modes.map((m, i) => {
      const [ok, of] = (success[i] ?? "0/0").split("/").map(Number);
      return [
        m,
        {
          success: ok ?? 0,
          tasks: of ?? 0,
          wrongfulHolds: Number(holds[i]),
          omitted: Number(omitted[i]),
        },
      ];
    }),
  ) as Record<Mode, ModeCounts>;

  const failed = [...text.matchAll(/^\s+(\w+)\s+plan\s+PLAN FAILED \((.*)\), \d+ refused/gm)].map(
    (m) => ({ taskId: m[1] ?? "", error: m[2] ?? "" }),
  );
  const failedIds = new Set(failed.map((f) => f.taskId));
  const columns = modes.map((m) => cells(header).indexOf(MODE_LABEL[m]));

  const after = Object.fromEntries(
    modes.map((m) => [
      m,
      {
        ...before[m],
        plannerFailures: failed.length,
        planned: (before[m]?.tasks ?? 0) - failed.length,
      },
    ]),
  ) as Record<Mode, ModeCounts & { plannerFailures: number; planned: number }>;
  for (const line of lines) {
    const c = cells(line);
    if (!c[0] || !failedIds.has(c[0])) continue;
    modes.forEach((m, i) => {
      const cell = c[columns[i] ?? -1] ?? "";
      const a = after[m];
      if (!a) return;
      if (cell === "ok") a.success--;
      a.wrongfulHolds -= (cell.match(/\bHOLD /g) ?? []).length;
      a.omitted -= (cell.match(/\bOMIT /g) ?? []).length;
    });
  }
  return { file: basename(file), failed, modes, before, after };
}

export function formatRescore(r: Rescored): string {
  const out = [`${r.file}`];
  if (r.failed.length === 0) {
    out.push("  no planner failures: scores unchanged");
    return out.join("\n");
  }
  out.push(`  planner failures: ${r.failed.map((f) => `${f.taskId} (${f.error})`).join("; ")}`);
  for (const m of r.modes) {
    const b = r.before[m];
    const a = r.after[m];
    if (!a || !b) continue;
    out.push(
      `  ${MODE_LABEL[m].padEnd(19)} success ${b.success}/${b.tasks} → ${a.success}/${a.tasks} (${a.success}/${a.planned} planned), ` +
        `wrongful holds ${b.wrongfulHolds} → ${a.wrongfulHolds}, omitted ${b.omitted} → ${a.omitted}`,
    );
  }
  return out.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const file of process.argv.slice(2)) {
    console.log(formatRescore(rescore(file, readFileSync(file, "utf8"))));
  }
}
