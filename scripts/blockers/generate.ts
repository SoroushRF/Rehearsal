// Builds the blocker board from the track files plus live GitHub state.
//   node scripts/blockers/generate.ts [--out BLOCKERS.md]
// Dependencies come from the "Blocked by" column in docs/tracks/*.md. Status comes from GitHub:
// issue closed → done; open PR that references the issue or task ID → in review; branch named
// after the task → in progress; otherwise ready or blocked by its dependencies.
// Uses GITHUB_TOKEN when set (CI), else `gh auth token`. No dependencies, runs on plain Node 24.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Status = "done" | "review" | "progress" | "ready" | "blocked";
type Task = {
  id: string;
  track: string;
  title: string;
  milestone: string;
  issue?: number;
  deps: string[];
  stretch: boolean;
  status: Status;
  openDeps: string[];
  blocks: string[];
};

const root = process.cwd();
const repo = process.env.GITHUB_REPOSITORY ?? "SoroushRF/Rehearsal";
const outArg = process.argv.indexOf("--out");
const out = outArg > 0 ? process.argv[outArg + 1] : undefined;

const token =
  process.env.GITHUB_TOKEN ?? execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();

async function gh<T>(path: string): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(
      `https://api.github.com/repos/${repo}/${path}${sep}per_page=100&page=${page}`,
      {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
      },
    );
    if (!res.ok) throw new Error(`GitHub ${path}: ${res.status} ${await res.text()}`);
    const batch = (await res.json()) as T[];
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

// ---- track files and roster ----

const tracksDir = join(root, "docs", "tracks");
const trackNames = new Map<string, string>();
const tasks = new Map<string, Task>();
for (const file of readdirSync(tracksDir)
  .filter((f) => /^T\d.*\.md$/.test(f))
  .sort()) {
  const text = readFileSync(join(tracksDir, file), "utf8");
  const track = file.slice(0, 2);
  trackNames.set(track, text.split("\n")[0].replace(/^# /, "").split(":")[0]);
  for (const line of text.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (!/^T\d\.\d+$/.test(cells[1] ?? "") || cells.length < 8) continue;
    const [, id, task, milestone, , issue, blockedBy] = cells;
    tasks.set(id, {
      id,
      track,
      title: task,
      milestone,
      issue: issue.match(/#(\d+)/) ? Number(issue.match(/#(\d+)/)?.[1]) : undefined,
      deps: blockedBy.match(/T\d\.\d+/g) ?? [],
      stretch: /_Stretch:_/.test(task),
      status: "ready",
      openDeps: [],
      blocks: [],
    });
  }
}

const roster = new Map<string, string>();
for (const line of readFileSync(join(root, "AGENTS.md"), "utf8").split("\n")) {
  const m = line.match(/^\| (T\d) [^|]+\| ([^|]+)\|/);
  if (m) roster.set(m[1], m[2].trim());
}

// ---- GitHub state ----

type Issue = { number: number; title: string; state: string; pull_request?: unknown };
type Pull = {
  number: number;
  title: string;
  body: string | null;
  draft: boolean;
  head: { ref: string };
};
type Branch = { name: string };

const [issues, pulls, branches] = await Promise.all([
  gh<Issue>("issues?state=all"),
  gh<Pull>("pulls?state=open"),
  gh<Branch>("branches"),
]);
const issueByNumber = new Map(issues.filter((i) => !i.pull_request).map((i) => [i.number, i]));

const mentions = (text: string, t: Task) =>
  (t.issue !== undefined && new RegExp(`#${t.issue}\\b`).test(text)) ||
  new RegExp(`\\b${t.id.replace(".", "\\.")}\\b`, "i").test(text);

for (const t of tasks.values()) {
  const issue = t.issue !== undefined ? issueByNumber.get(t.issue) : undefined;
  if (issue) t.title = issue.title.replace(/^T\d\.\d+\s+/, "");
  else t.title = t.title.replace(/_Stretch:_\s*/, "").split(/[:;]\s/)[0];
}
const prFor = new Map<string, Pull>();
for (const t of tasks.values()) {
  const issue = t.issue !== undefined ? issueByNumber.get(t.issue) : undefined;
  // A PR counts only if its branch or title names the task, or its body closes/refs the issue.
  // A passing mention ("T4.3 waits on #19") doesn't put #19 in review.
  const closes = (body: string) =>
    t.issue !== undefined &&
    new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?|refs?)\\s+#${t.issue}\\b`, "i").test(body);
  const pr = pulls.find(
    (p) => mentions(`${p.head.ref.replace(/-/g, " ")}\n${p.title}`, t) || closes(p.body ?? ""),
  );
  if (pr) prFor.set(t.id, pr);
  if (issue?.state === "closed") t.status = "done";
  else if (pr) t.status = "review";
  else if (branches.some((b) => mentions(b.name.replace(/-/g, " "), t))) t.status = "progress";
}
for (const t of tasks.values()) {
  t.openDeps = t.deps.filter((d) => tasks.get(d)?.status !== "done");
  if (t.status === "ready" && t.openDeps.length > 0) t.status = "blocked";
  for (const d of t.deps) tasks.get(d)?.blocks.push(t.id);
}

// Open tasks that transitively wait on this one.
function downstream(id: string, seen = new Set<string>()): Set<string> {
  for (const b of tasks.get(id)?.blocks ?? []) {
    if (seen.has(b) || tasks.get(b)?.status === "done") continue;
    seen.add(b);
    downstream(b, seen);
  }
  return seen;
}

// ---- render ----

const badge: Record<Status, string> = {
  done: "✅ done",
  review: "👀 in review",
  progress: "🔨 in progress",
  ready: "🟨 ready",
  blocked: "🟥 blocked",
};
const issueLink = (t: Task) =>
  t.issue !== undefined ? `[#${t.issue}](https://github.com/${repo}/issues/${t.issue})` : "";
const ref = (id: string) => {
  const d = tasks.get(id);
  return d ? `${id} (${d.track}, ${badge[d.status].split(" ").slice(1).join(" ")})` : id;
};
const label = (t: Task) => `${t.id} ${t.title}`.replace(/["#&;<>[\]{}|]/g, "").slice(0, 48);

const lines: string[] = [
  "# Blocker board",
  "",
  "**Generated automatically. Don't edit this file.** It rebuilds when issues change or anything merges to main, and every 10 minutes. Dependencies come from the **Blocked by** column in [`docs/tracks/`](https://github.com/" +
    repo +
    "/tree/main/docs/tracks); change them there through a PR.",
  "",
  `Legend: ${Object.values(badge).join(" · ")}`,
  "",
];

const open = [...tasks.values()].filter((t) => t.status !== "done" && !t.stretch);
const done = [...tasks.values()].filter((t) => t.status === "done").length;
const top = open
  .map((t) => ({ t, n: downstream(t.id).size }))
  .filter((x) => x.n > 0)
  .sort((a, b) => b.n - a.n || a.t.id.localeCompare(b.t.id))
  .slice(0, 6);

lines.push(
  "## Top blockers",
  "",
  `${done} of ${tasks.size} tasks done. These open tasks hold up the most other work:`,
  "",
  "| Task | Track owner | Status | Open tasks waiting on it |",
  "|---|---|---|---|",
  ...top.map(
    ({ t, n }) =>
      `| **${t.id}** ${t.title} ${issueLink(t)} | ${roster.get(t.track) ?? "?"} | ${badge[t.status]} | ${n} |`,
  ),
  "",
);

for (const [track, name] of trackNames) {
  lines.push(
    `## ${name}`,
    "",
    `**Owner:** ${roster.get(track) ?? "?"}`,
    "",
    "| Task | Status | Blocked by | Blocks |",
    "|---|---|---|---|",
  );
  for (const t of [...tasks.values()].filter((x) => x.track === track)) {
    const pr = prFor.get(t.id);
    const status = `${badge[t.status]}${pr && t.status === "review" ? ` [PR #${pr.number}](https://github.com/${repo}/pull/${pr.number})` : ""}`;
    const blockedBy = t.status === "done" ? "" : t.openDeps.map(ref).join("<br>") || "—";
    const blocks = t.blocks.map((b) =>
      tasks.get(b)?.track === track ? b : `${b} (${tasks.get(b)?.track})`,
    );
    lines.push(
      `| **${t.id}** ${t.title}${t.stretch ? " _(stretch)_" : ""} ${issueLink(t)} | ${status} | ${blockedBy} | ${blocks.join(", ")} |`,
    );
  }
  lines.push("");
}

lines.push(
  "## Task graph",
  "",
  "An arrow `A --> B` means B waits on A. Stretch tasks are left out.",
  "",
  "```mermaid",
  "flowchart LR",
  "  classDef done fill:#d3f9d8,stroke:#2b8a3e,color:#1b4332",
  "  classDef review fill:#d0ebff,stroke:#1971c2,color:#0b3460",
  "  classDef progress fill:#e5dbff,stroke:#5f3dc4,color:#2b1a66",
  "  classDef ready fill:#fff3bf,stroke:#e67700,color:#5c3c00",
  "  classDef blocked fill:#ffe3e3,stroke:#c92a2a,color:#5c0a0a",
);
const node = (id: string) => id.replace(".", "_");
for (const [track, name] of trackNames) {
  lines.push(`  subgraph ${track}[${name}]`);
  for (const t of [...tasks.values()].filter((x) => x.track === track && !x.stretch))
    lines.push(`    ${node(t.id)}["${label(t)}"]:::${t.status}`);
  lines.push("  end");
}
for (const t of tasks.values())
  for (const d of t.deps)
    if (!t.stretch && tasks.has(d)) lines.push(`  ${node(d)} --> ${node(t.id)}`);
lines.push("```", "");

const md = lines.join("\n");
if (out) writeFileSync(out, md);
else process.stdout.write(md);
