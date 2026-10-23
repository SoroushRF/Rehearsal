import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import type { BillingPolicyV1 } from "@rehearsal/core";
import { PlanningSession } from "@rehearsal/planner";
import { STRIPE_CHARGE_PROJECTION, ZENDESK_TICKET_PROJECTION } from "@rehearsal/providers";
import { INCIDENT } from "@rehearsal/testkit";
import policyJson from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import { pinnedImage, resetScratchTenants } from "../../providers/src/harness";
import { AGENT_ID, AGENT_VERSION, runAgent } from "./agent";
import { applyCalls, applyPlan } from "./modes";
import { formatScorecard, MODES, type ModeRun, scoreRun, summarize } from "./score";
import { TASKS } from "./tasks";
import {
  applyDrift,
  countingEraCalls,
  operationalPorts,
  readers,
  readOutcomes,
  records,
  seededWorlds,
  type Worlds,
} from "./world";

/**
 * `pnpm eval:scorecard`: every task in every mode on real Era (needs `pnpm infra:up` and
 * ERA_ADMIN_TOKEN in .env). Prints the comparison table and writes the results file.
 *   --only B1,T3   run some tasks
 *   --out <path>   results file (default evals/scorecard/results/latest.json)
 */

const { values } = parseArgs({
  options: {
    only: { type: "string" },
    out: { type: "string", default: "evals/scorecard/results/latest.json" },
  },
});
const only = values.only?.split(",").map((s) => s.trim());
const tasks = only ? TASKS.filter((t) => only.includes(t.id)) : TASKS;
if (tasks.length === 0) throw new Error(`no tasks match --only ${values.only}`);
if (!process.env.ERA_ADMIN_TOKEN) {
  console.error("ERA_ADMIN_TOKEN is not set. Copy .env.example to .env and run `pnpm infra:up`.");
  process.exit(1);
}

const policy = policyJson as BillingPolicyV1;
const ctxOf = (w: Worlds) => ({
  stripe: { world: "operational" as const, tenant: w.stripe.tenant },
  zendesk: { world: "operational" as const, tenant: w.zendesk.tenant },
});

const runs: ModeRun[] = [];
const details: object[] = [];
let planningCalls = 0;
const started = Date.now();
try {
  // One planning world for every task: the agent only reads it, and drift never reaches it.
  const planning = await seededWorlds("planning", "sc-plan");
  for (const task of tasks) {
    const session = new PlanningSession({
      readers: readers(planning, "planning"),
      ctx: { world: "planning", tenant: planning.stripe.tenant },
      policy,
      window: INCIDENT.window,
    });
    const agent = await countingEraCalls([planning], () =>
      runAgent(task, records.cases, session, {
        orgId: "org_scorecard",
        incidentId: INCIDENT.incident,
        planId: `plan_scorecard_${task.id}`,
        adapters: { stripe: STRIPE_CHARGE_PROJECTION, zendesk: ZENDESK_TICKET_PROJECTION },
      }),
    );
    planningCalls += agent.calls;
    const { intents, manifest } = agent.value;

    for (const mode of MODES) {
      const op = await seededWorlds("operational", `sc-${task.id}-${mode}`.toLowerCase());
      await applyDrift(op, task.drift);
      const ports = operationalPorts(op, task.faults);
      const t0 = performance.now();
      const applied = await countingEraCalls([op], () =>
        mode === "rehearsal"
          ? applyPlan(manifest, ports, ctxOf(op), policy)
          : applyCalls(intents, ports, ctxOf(op), { taskId: task.id, review: mode === "per_call" }),
      );
      const latencyMs = Math.round(performance.now() - t0);
      const run: ModeRun = {
        taskId: task.id,
        mode,
        cases: await readOutcomes(op),
        unresolved: applied.value.unresolved,
        reviewerActions: applied.value.reviewerActions,
        promptOpportunities: applied.value.promptOpportunities,
        latencyMs,
        eraCalls: applied.calls,
      };
      runs.push(run);
      const score = scoreRun(task, run);
      // The step log only where something went wrong; the rest is in the table.
      details.push(score.success ? score : { ...score, log: applied.value.log });
      console.log(
        `${task.id.padEnd(3)} ${mode.padEnd(9)} ${score.success ? "ok" : "FAIL"} ${score.problems
          .map((p) => `${p.kind} ${p.caseKey}.${p.field} ${p.expected}→${p.actual}`)
          .join("; ")}`,
      );
    }
    details.push({
      taskId: task.id,
      plan: {
        actions: manifest.actions.length,
        refused: intents.filter((i) => !i.accepted).map((i) => `${i.intent.tool}: ${i.refusal}`),
      },
    });
  }
} finally {
  await resetScratchTenants();
}

const table = formatScorecard(tasks, runs);
const modelPanel = [
  "Model panel",
  `  planner: ${AGENT_ID} (${AGENT_VERSION}), a scripted rule-following agent; the same plan feeds every mode`,
  "  model tokens: 0 (no model was called; a Claude-planner run needs ANTHROPIC_API_KEY and is not part of this run)",
  `  planning-phase Era reads: ${planningCalls} across ${tasks.length} tasks (shared by all modes)`,
].join("\n");
console.log(`\n${table}\n\n${modelPanel}\n`);

const out = values.out ?? "evals/scorecard/results/latest.json";
mkdirSync(dirname(out), { recursive: true });
const header = [
  `evidence: era_integration (pinned Era images, ${new Date(started).toISOString()})`,
  `  ${pinnedImage("stripe")}`,
  `  ${pinnedImage("zendesk")}`,
  "  faults are injected in the write transport, not with Era's /_admin/faults",
].join("\n");
writeFileSync(out.replace(/\.json$/, ".txt"), `${header}\n\n${table}\n\n${modelPanel}\n`);
writeFileSync(
  out,
  `${JSON.stringify(
    {
      evidence: "era_integration",
      note: "Real Era images (pinned digests below). Faults are injected in the transport, not with Era's /_admin/faults. The per-call reviewer is modelled, not a person.",
      ranAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      images: { stripe: pinnedImage("stripe"), zendesk: pinnedImage("zendesk") },
      planner: {
        id: AGENT_ID,
        version: AGENT_VERSION,
        modelTokens: 0,
        planningEraCalls: planningCalls,
      },
      summary: summarize(tasks, runs),
      runs,
      details,
    },
    null,
    2,
  )}\n`,
);
console.log(`results → ${out}`);
