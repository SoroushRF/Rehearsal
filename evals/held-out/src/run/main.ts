import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import type { BillingPolicy } from "@rehearsal/core";
import { PlanningSession } from "@rehearsal/planner";
import { STRIPE_CHARGE_PROJECTION, ZENDESK_TICKET_PROJECTION } from "@rehearsal/providers";
import { pinnedImage, resetScratchTenants, resetTenant } from "../../../providers/src/harness";
import {
  AGENT_ID,
  AGENT_VERSION,
  type AgentResult,
  proposedByCase,
  runAgent,
  SUMMARY_CHANNEL,
} from "../../../scorecard/src/agent";
import { applyCompetent } from "../../../scorecard/src/competent";
import { applyCalls, applyPlan } from "../../../scorecard/src/modes";
import type { Mode, ModeRun } from "../../../scorecard/src/score";
import type { ScorecardTask } from "../../../scorecard/src/tasks";
import {
  countingEraCalls,
  countOutside,
  readOurEffects,
  readSummary,
  type Worlds,
} from "../../../scorecard/src/world";
import { deriveSeed } from "../catalog";
import { loadGold } from "../gold";
import { Manifest, MODES, planRuns } from "../run-plan";
import type { Task } from "../schema";
import { type HeldOutSet, loadSet, POLICIES, type Split, setIds, splitRoot } from "../sets";
import { type HeldOutScore, scoreHeldOut } from "./score";
import { applyDrift, knownOf, operationalPorts, readers, readOutcomes, setWorlds } from "./world";

/**
 * T1.35 `pnpm eval:held-out`: held-out (or catalog) tasks in each mode on real Era, scored against
 * the set's gold. Needs `pnpm infra:up` and ERA_ADMIN_TOKEN in .env, plus the Slack worlds for a
 * set that posts a summary. The scorecard's scripted agent plans each task once in a planning world
 * seeded with the set; every mode then applies that plan to its own fresh operational world, with
 * the task's drift and faults. Its rules don't change per set: it refunds every same-invoice
 * duplicate it finds and never picks a balance credit, which every gold accepts where a credit is
 * optional. A task that needs a harness feature the runner lacks (the precedent registry) is
 * reported not run, never scored.
 *   --split held-out|catalog   (default held-out)
 *   --set ho1,ho2              sets (default all in the split)
 *   --only HO1-3,G02-14        tasks
 *   --family lost_response     catalog families
 *   --modes direct,rehearsal   (default all four on held-out; the catalog's run plan default)
 *   --repeat <n>               attempts per task and mode (the scripted planner is deterministic)
 *   --concurrency <n>          cases the executor applies at once in Rehearsal mode (default 1)
 *   --out <path>               results file (default evals/held-out/results/<split>-latest.json)
 */

const { values } = parseArgs({
  options: {
    split: { type: "string", default: "held-out" },
    set: { type: "string" },
    only: { type: "string" },
    family: { type: "string" },
    modes: { type: "string" },
    repeat: { type: "string", default: "1" },
    concurrency: { type: "string", default: "1" },
    out: { type: "string" },
  },
});
const list = (s?: string) =>
  s
    ?.split(",")
    .map((x) => x.trim())
    .filter(Boolean);
const split = values.split as Split;
if (split !== "held-out" && split !== "catalog") throw new Error(`--split: ${values.split}`);
const caseConcurrency = Number(values.concurrency);
if (!Number.isInteger(caseConcurrency) || caseConcurrency < 1) {
  throw new Error(
    `--concurrency must be a whole number of cases, at least 1: ${values.concurrency}`,
  );
}
const repeat = Number(values.repeat);
const modes = list(values.modes) as Mode[] | undefined;
for (const m of modes ?? []) if (!MODES.includes(m)) throw new Error(`unknown mode ${m}`);
if (!process.env.ERA_ADMIN_TOKEN) {
  console.error("ERA_ADMIN_TOKEN is not set. Copy .env.example to .env and run `pnpm infra:up`.");
  process.exit(1);
}

interface Attempt {
  set: string;
  task: string;
  family?: string;
  mode: Mode;
  attempt: number;
  seed: number;
}

const attempts: Attempt[] =
  split === "catalog"
    ? planRuns(
        Manifest.parse(
          JSON.parse(readFileSync(new URL("manifest.json", splitRoot("catalog")), "utf8")),
        ),
        {
          only: list(values.only),
          sets: list(values.set),
          families: list(values.family),
          modes,
          repeat,
        },
      ).attempts.map((a) => ({ ...a, task: a.config }))
    : (list(values.set) ?? setIds()).flatMap((setId) =>
        loadSet(setId).tasks.tasks.flatMap((t) =>
          (!list(values.only) || list(values.only)?.includes(t.id)
            ? (modes ?? [...MODES])
            : []
          ).flatMap((mode) =>
            Array.from({ length: repeat }, (_, i) => ({
              set: setId,
              task: t.id,
              mode,
              attempt: i + 1,
              seed: deriveSeed("held-out", t.id, mode, i + 1),
            })),
          ),
        ),
      );
if (attempts.length === 0) throw new Error("the selection matches no task");

/** Every policy version the executor may be asked to check a plan against. */
const policies = [1, 2, 3].map(
  (v) => JSON.parse(readFileSync(new URL(`policy.v${v}.json`, POLICIES), "utf8")) as BillingPolicy,
);

/** The scorecard agent's view of a held-out task: its scope and the set's ops, nothing careless. */
function agentTask(set: HeldOutSet, task: Task): ScorecardTask {
  return {
    id: task.id,
    kind: "benign",
    title: task.title,
    scope: task.scope === "all" ? set.records.cases.map((c) => c.key) : task.scope,
    careless: [],
    drift: [],
    faults: [],
    ops: { credits: [], replies: set.tasks.ops.replies, summary: set.tasks.ops.summary },
    gold: {},
    summaryPosts: 0,
    why: "",
  };
}

const ctxOf = (w: Worlds) => ({
  stripe: { world: "operational" as const, tenant: w.stripe.tenant },
  zendesk: { world: "operational" as const, tenant: w.zendesk.tenant },
  ...(w.slack && { slack: { world: "operational" as const, tenant: w.slack.tenant } }),
});

interface RunRecord {
  set: string;
  family?: string;
  attempt: number;
  seed: number;
  run: ModeRun;
  score: HeldOutScore;
  log?: string[];
}

const records: RunRecord[] = [];
const notRun: { set: string; task: string; requires: string[] }[] = [];
const plans: Record<string, { actions: number; refused: string[] }> = {};
let planningCalls = 0;
const started = Date.now();
try {
  for (const setId of [...new Set(attempts.map((a) => a.set))]) {
    const set = loadSet(setId, split);
    const gold = loadGold(setId, split);
    const mine = attempts.filter((a) => a.set === setId);
    const tasks = set.tasks.tasks.filter((t) => mine.some((a) => a.task === t.id));
    const runnable = tasks.filter((t) => {
      if (t.requires.length === 0) return true;
      notRun.push({ set: setId, task: t.id, requires: t.requires });
      console.log(`${t.id.padEnd(7)} not run: needs ${t.requires.join(", ")}`);
      return false;
    });
    if (runnable.length === 0) continue;

    // One planning world per set: the agent only reads it, and drift never reaches it.
    const planning = await setWorlds(set, "planning", `ho-plan-${setId}`);
    const planningCtx = { world: "planning" as const, tenant: planning.stripe.tenant };
    for (const task of runnable) {
      const scripted = agentTask(set, task);
      const session = new PlanningSession({
        readers: readers(planning, "planning"),
        ctx: planningCtx,
        policy: set.policy,
        window: set.incident.window,
        ...(set.tasks.ops.credits && { credits: true }),
        ...(set.tasks.ops.replies && {
          customerNames: Object.fromEntries(set.incident.cases.map((c) => [c.customerId, c.name])),
        }),
        ...(set.tasks.ops.summary && {
          runSummary: { channelId: SUMMARY_CHANNEL, incidentId: set.incident.incident },
        }),
      });
      const agent = await countingEraCalls<AgentResult>([planning], () =>
        runAgent(scripted, set.records.cases, session, {
          orgId: "org_held_out",
          incidentId: set.incident.incident,
          planId: `plan_held_out_${task.id}`,
          adapters: { stripe: STRIPE_CHARGE_PROJECTION, zendesk: ZENDESK_TICKET_PROJECTION },
        }),
      );
      planningCalls += agent.calls;
      const { intents, manifest, coverage } = agent.value;
      plans[task.id] = {
        actions: manifest.actions.length,
        refused: intents.filter((i) => !i.accepted).map((i) => `${i.intent.tool}: ${i.refusal}`),
      };

      for (const a of mine.filter((x) => x.task === task.id)) {
        const op = await setWorlds(set, "operational", `ho-${task.id}-${a.mode}`.toLowerCase());
        await applyDrift(set, op, task.drift);
        const ports = operationalPorts(set, op, task.faults);
        const t0 = performance.now();
        const applied = await countingEraCalls([op], () =>
          a.mode === "rehearsal"
            ? coverage?.length
              ? Promise.resolve({
                  unresolved: 0,
                  reviewerActions: 0,
                  promptOpportunities: 0,
                  log: ["caught before approval: incomplete coverage"],
                })
              : applyPlan(manifest, ports, ctxOf(op), policies, caseConcurrency)
            : a.mode === "competent"
              ? applyCompetent(intents, ports, ctxOf(op), {
                  taskId: task.id,
                  policy: set.policy,
                  window: set.incident.window,
                })
              : applyCalls(intents, ports, ctxOf(op), {
                  taskId: task.id,
                  review: a.mode === "per_call",
                }),
        );
        const latencyMs = Math.round(performance.now() - t0);
        const run: ModeRun = {
          taskId: task.id,
          mode: a.mode,
          cases: await readOutcomes(set, task, op),
          proposed: proposedByCase(
            intents,
            set.records.cases.map((c) => c.key),
          ),
          coverage,
          summary: await readSummary(op),
          unresolved: applied.value.unresolved,
          reviewerActions: applied.value.reviewerActions,
          promptOpportunities: applied.value.promptOpportunities,
          latencyMs,
          eraCalls: applied.calls,
          outside: countOutside(await readOurEffects(op, knownOf(set, task)), knownOf(set, task)),
        };
        const score = scoreHeldOut(set, task, gold, run);
        records.push({
          set: setId,
          ...(a.family && { family: a.family }),
          attempt: a.attempt,
          seed: a.seed,
          run,
          score,
          // The step log only where something went wrong.
          ...(!score.success && { log: applied.value.log }),
        });
        console.log(
          `${task.id.padEnd(7)} ${a.mode.padEnd(9)} ${score.success ? "ok" : "FAIL"} ${score.problems
            .map((p) => `${p.kind} ${p.caseKey}.${p.field} ${p.expected}→${p.actual}`)
            .join("; ")}`,
        );
        // Keep Era's memory flat over a long run; the end state is already read.
        for (const w of [op.stripe, op.zendesk, op.slack]) if (w) await resetTenant(w);
      }
    }
  }
} finally {
  await resetScratchTenants();
}

/** Success and problem counts per mode, over any grouping of the runs. */
function tally(rows: readonly RunRecord[]) {
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const t = out[r.run.mode] ?? {
      runs: 0,
      success: 0,
      invalid_allow: 0,
      duplicate: 0,
      wrongful_hold: 0,
      omitted: 0,
      incorrect: 0,
      unresolved: 0,
      eraCalls: 0,
    };
    out[r.run.mode] = t;
    t.runs = (t.runs ?? 0) + 1;
    if (r.score.success) t.success = (t.success ?? 0) + 1;
    for (const p of r.score.problems) t[p.kind] = (t[p.kind] ?? 0) + 1;
    t.unresolved = (t.unresolved ?? 0) + r.run.unresolved;
    t.eraCalls = (t.eraCalls ?? 0) + r.run.eraCalls;
  }
  return out;
}
const groupBy = (key: (r: RunRecord) => string | undefined) =>
  Object.fromEntries(
    [...new Set(records.map(key))]
      .filter((k): k is string => k !== undefined)
      .map((k) => [k, tally(records.filter((r) => key(r) === k))]),
  );

const summary = tally(records);
const table = [
  `mode       runs  success  invalid_allow  duplicate  wrongful_hold  omitted  incorrect  unresolved`,
  ...Object.entries(summary).map(
    ([mode, t]) =>
      `${mode.padEnd(10)} ${String(t.runs).padStart(4)}  ${String(t.success).padStart(7)}  ${String(t.invalid_allow).padStart(13)}  ${String(t.duplicate).padStart(9)}  ${String(t.wrongful_hold).padStart(13)}  ${String(t.omitted).padStart(7)}  ${String(t.incorrect).padStart(9)}  ${String(t.unresolved).padStart(10)}`,
  ),
  ...(notRun.length > 0
    ? [`not run (needs a harness feature): ${notRun.map((n) => n.task).join(", ")}`]
    : []),
].join("\n");
console.log(`\n${table}\n`);

const out = values.out ?? `evals/held-out/results/${split}-latest.json`;
mkdirSync(dirname(out), { recursive: true });
const header = [
  `evidence: era_integration (pinned Era images, ${new Date(started).toISOString()}), split ${split}, commit ${headCommit()}`,
  `  ${pinnedImage("stripe")}`,
  `  ${pinnedImage("zendesk")}`,
  `  planner: ${AGENT_ID} (${AGENT_VERSION}); faults are injected in the transport, not with Era's /_admin/faults`,
].join("\n");
writeFileSync(out.replace(/\.json$/, ".txt"), `${header}\n\n${table}\n`);
writeFileSync(
  out,
  `${JSON.stringify(
    {
      evidence: "era_integration",
      split,
      note: "Real Era images (pinned digests below), scored against the set's gold. The scripted agent plans; the per-call reviewer is modelled, not a person. Signers are not scored (a plan property).",
      ranAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      caseConcurrency,
      commit: headCommit(),
      images: { stripe: pinnedImage("stripe"), zendesk: pinnedImage("zendesk") },
      planner: {
        id: AGENT_ID,
        version: AGENT_VERSION,
        modelTokens: 0,
        planningEraCalls: planningCalls,
      },
      summary,
      bySet: groupBy((r) => r.set),
      ...(split === "catalog" && { byFamily: groupBy((r) => r.family) }),
      notRun,
      plans,
      runs: records,
    },
    null,
    2,
  )}\n`,
);
console.log(`results → ${out}`);

/** The commit the results came from, so a report can name it. */
function headCommit(): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      encoding: "utf8",
    }).trim();
    return dirty ? `${sha}+uncommitted` : sha;
  } catch {
    return "unknown";
  }
}
