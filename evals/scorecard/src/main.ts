import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import type { BillingPolicyV1 } from "@rehearsal/core";
import { type MessagesClient, PlanningSession, PROMPT_VERSION } from "@rehearsal/planner";
import { STRIPE_CHARGE_PROJECTION, ZENDESK_TICKET_PROJECTION } from "@rehearsal/providers";
import { INCIDENT } from "@rehearsal/testkit";
import policyJson from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import { pinnedImage, resetScratchTenants } from "../../providers/src/harness";
import { AGENT_ID, AGENT_VERSION, type AgentResult, runAgent } from "./agent";
import {
  addUsage,
  describeModelPlan,
  type ModelAgentResult,
  NO_TOKENS,
  runModelAgent,
} from "./model";
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
 *
 * With PLANNER_MODEL set, every task is planned by that model through the planner's bounded tool
 * loop (Gemini on Vertex AI needs GOOGLE_CLOUD_PROJECT and ADC; Claude needs ANTHROPIC_API_KEY),
 * and the default results file is evals/scorecard/results/model-<model>.json. That calls the model
 * once per task, so it costs real credits. Without it, the scripted agent plans, as before.
 */

const { values } = parseArgs({
  options: {
    only: { type: "string" },
    out: { type: "string" },
  },
});
const model = process.env.PLANNER_MODEL?.trim() || undefined;
const only = values.only?.split(",").map((s) => s.trim());
const tasks = only ? TASKS.filter((t) => only.includes(t.id)) : TASKS;
if (tasks.length === 0) throw new Error(`no tasks match --only ${values.only}`);
if (!process.env.ERA_ADMIN_TOKEN) {
  console.error("ERA_ADMIN_TOKEN is not set. Copy .env.example to .env and run `pnpm infra:up`.");
  process.exit(1);
}
// Planning phase only: the modes below never see the model client.
const client = model ? await modelClient(model) : undefined;

const policy = policyJson as BillingPolicyV1;
const ctxOf = (w: Worlds) => ({
  stripe: { world: "operational" as const, tenant: w.stripe.tenant },
  zendesk: { world: "operational" as const, tenant: w.zendesk.tenant },
});

const runs: ModeRun[] = [];
const details: object[] = [];
let planningCalls = 0;
const modelPlans = new Map<string, ModelAgentResult>();
const started = Date.now();
try {
  // One planning world for every task: the agent only reads it, and drift never reaches it.
  const planning = await seededWorlds("planning", "sc-plan");
  for (const task of tasks) {
    const planningCtx = { world: "planning" as const, tenant: planning.stripe.tenant };
    const meta = {
      orgId: "org_scorecard",
      incidentId: INCIDENT.incident,
      planId: `plan_scorecard_${task.id}`,
      adapters: { stripe: STRIPE_CHARGE_PROJECTION, zendesk: ZENDESK_TICKET_PROJECTION },
    };
    const agent = await countingEraCalls<AgentResult | ModelAgentResult>([planning], () => {
      if (model && client) {
        return runModelAgent(task, records.cases, {
          client,
          model,
          readers: readers(planning, "planning"),
          ctx: planningCtx,
          policy,
          meta,
        });
      }
      const session = new PlanningSession({
        readers: readers(planning, "planning"),
        ctx: planningCtx,
        policy,
        window: INCIDENT.window,
      });
      return runAgent(task, records.cases, session, meta);
    });
    planningCalls += agent.calls;
    const { intents, manifest } = agent.value;
    const planned = "outcome" in agent.value ? agent.value : undefined;
    if (planned) {
      modelPlans.set(task.id, planned);
      console.log(describeModelPlan(task.id, planned));
    }

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
        ...(planned && {
          outcome: planned.outcome,
          turns: planned.turns,
          toolCalls: planned.toolCalls,
          usage: planned.usage,
          unsendable: planned.unsendable,
          summary: planned.summary,
        }),
      },
    });
  }
} finally {
  await resetScratchTenants();
}

const table = formatScorecard(tasks, runs);
const plans = [...modelPlans.values()];
const tokens = plans.reduce((t, p) => addUsage(t, p.usage), NO_TOKENS);
const totalTokens = tokens.inputTokens + tokens.cacheReadTokens + tokens.outputTokens;
const modelRequests = plans.reduce((n, p) => n + p.turns, 0);
const countPlans = (status: ModelAgentResult["outcome"]["status"]) =>
  plans.filter((p) => p.outcome.status === status).length;
const modelPanel = (
  model
    ? [
        "Model panel",
        `  planner: ${model}, prompt ${PROMPT_VERSION}, through runPlanningLoop (the planner worker's bounded tool loop) over the shared planning world; each task is planned on its own and its plan feeds every mode`,
        `  model tokens: ${totalTokens} (${tokens.inputTokens} input + ${tokens.cacheReadTokens} cached input, ${tokens.outputTokens} output incl. thinking) in ${modelRequests} model requests`,
        `  plans: ${countPlans("planned")} planned, ${countPlans("empty")} with no steps, ${countPlans("failed")} failed`,
        "    (a failed plan is never stored, so Rehearsal applies nothing; direct and per-call still send what the model tried)",
        ...[...modelPlans].map(([id, p]) => `  ${describeModelPlan(id, p)}`),
        "  Direct and per-call send every propose call the model made, including the ones the planning tools refused.",
        "  T6-T9's careless mistakes belong to the scripted agent. The model isn't told to make them, so those rows show whether it makes them on its own.",
        `  planning-phase Era reads: ${planningCalls} across ${tasks.length} tasks (shared by all modes)`,
      ]
    : [
        "Model panel",
        `  planner: ${AGENT_ID} (${AGENT_VERSION}), a scripted rule-following agent; the same plan feeds every mode`,
        "  model tokens: 0 (no model was called; set PLANNER_MODEL for a real-model run, written to results/model-<model>.*)",
        `  planning-phase Era reads: ${planningCalls} across ${tasks.length} tasks (shared by all modes)`,
      ]
).join("\n");
console.log(`\n${table}\n\n${modelPanel}\n`);

const out =
  values.out ??
  (model
    ? `evals/scorecard/results/model-${model.replace(/[^A-Za-z0-9._-]/g, "_")}.json`
    : "evals/scorecard/results/latest.json");
mkdirSync(dirname(out), { recursive: true });
const header = [
  model
    ? `evidence: era_integration + model ${model} (live model calls, pinned Era images, ${new Date(started).toISOString()})`
    : `evidence: era_integration (pinned Era images, ${new Date(started).toISOString()})`,
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
      ...(model && { model }),
      note: `Real Era images (pinned digests below)${model ? `; every task planned by ${model} with live model calls` : ""}. Faults are injected in the transport, not with Era's /_admin/faults. The per-call reviewer is modelled, not a person.`,
      ranAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      images: { stripe: pinnedImage("stripe"), zendesk: pinnedImage("zendesk") },
      planner: model
        ? {
            id: model,
            kind: "model",
            promptVersion: PROMPT_VERSION,
            modelTokens: totalTokens,
            usage: tokens,
            modelRequests,
            plans: Object.fromEntries(
              [...modelPlans].map(([id, p]) => [
                id,
                { outcome: p.outcome, steps: p.manifest.actions.length, usage: p.usage },
              ]),
            ),
            planningEraCalls: planningCalls,
          }
        : {
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

/** The planner worker's model client: Gemini on Vertex AI (ADC), or Claude with an API key. */
async function modelClient(model: string): Promise<MessagesClient> {
  if (model.startsWith("gemini-")) {
    const project = process.env.GOOGLE_CLOUD_PROJECT;
    if (!project) {
      console.error(`PLANNER_MODEL=${model} runs on Vertex AI and needs GOOGLE_CLOUD_PROJECT.`);
      process.exit(1);
    }
    const { GoogleGenAI } = await import("@google/genai");
    const { geminiMessagesClient } = await import("../../../apps/planner-worker/src/gemini");
    return geminiMessagesClient(
      new GoogleGenAI({
        vertexai: true,
        project,
        location: process.env.GOOGLE_CLOUD_LOCATION || "global",
      }).models,
    );
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(`PLANNER_MODEL=${model} needs ANTHROPIC_API_KEY.`);
    process.exit(1);
  }
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return new Anthropic().messages;
}
