import { GoogleGenAI, type GoogleGenAIOptions } from "@google/genai";
import type { BillingPolicyV1 } from "@rehearsal/core";
import {
  incidentBrief,
  PlanningLoopError,
  PlanningSession,
  runPlanningLoop,
} from "@rehearsal/planner";
import {
  primeTokens,
  STRIPE_CHARGE_PROJECTION,
  stripeReader,
  workerWorlds,
  ZENDESK_TICKET_PROJECTION,
  zendeskReader,
} from "@rehearsal/providers";
import policy from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import { plannerCredentialViolations } from "../src/credentials";
import { geminiMessagesClient } from "../src/gemini";

/**
 * Live smoke for the Gemini adapter: a real model over the real planning world, cut off after
 * MAX_TURNS so it costs cents. Turn 2 sends turn 1's tool results back with its thought
 * signatures, which is the part a scripted test can't prove. Nothing is stored or applied.
 *
 *   tsx --env-file=../../.env.planner scripts/smoke-gemini.ts
 *
 * GOOGLE_ACCESS_TOKEN (e.g. `gcloud auth print-access-token`) overrides ADC for one run.
 */
const MAX_TURNS = Number(process.env.SMOKE_TURNS ?? 2);
const forbidden = plannerCredentialViolations();
if (forbidden.length > 0) throw new Error(`must not receive: ${forbidden.join(", ")}`);
const model = process.env.PLANNER_MODEL ?? "";
const project = process.env.GOOGLE_CLOUD_PROJECT;
if (!model.startsWith("gemini-") || !project) {
  throw new Error("needs PLANNER_MODEL=gemini-… and GOOGLE_CLOUD_PROJECT");
}

const token = process.env.GOOGLE_ACCESS_TOKEN;
const options: GoogleGenAIOptions = {
  vertexai: true,
  project,
  location: process.env.GOOGLE_CLOUD_LOCATION || "global",
};
if (token) {
  options.googleAuthOptions = {
    authClient: {
      getRequestHeaders: async () => new Headers({ Authorization: `Bearer ${token}` }),
    } as never,
  };
}

const worlds = workerWorlds("planner");
await primeTokens(worlds);
const brief = incidentBrief("INC-BILL-0927");
if (!brief) throw new Error("no brief");
const session = new PlanningSession({
  readers: {
    stripe: stripeReader({
      world: "planning",
      config: worlds.stripe,
      authorization: "Bearer sk_test_rehearsal_planner",
    }),
    zendesk: zendeskReader({
      world: "planning",
      config: worlds.zendesk,
      authorization: "Bearer rehearsal-planner",
    }),
  },
  ctx: { world: "planning", tenant: worlds.stripe.tenant },
  policy: policy as BillingPolicyV1,
  window: brief.window,
});

const usage = { input: 0, output: 0 };
try {
  const result = await runPlanningLoop({
    client: geminiMessagesClient(new GoogleGenAI(options).models),
    model,
    session,
    brief,
    meta: {
      orgId: "org_smoke",
      planId: "plan_smoke",
      adapters: { stripe: STRIPE_CHARGE_PROJECTION, zendesk: ZENDESK_TICKET_PROJECTION },
    },
    limits: { maxTurns: MAX_TURNS, maxTokensPerTurn: 4_000 },
    signal: AbortSignal.timeout(120_000),
    onTurn: (t) => {
      usage.input += t.usage.input_tokens;
      usage.output += t.usage.output_tokens;
      const calls = t.toolCalls.map((c) => (c.ok ? c.name : `${c.name} ✗ ${c.error}`));
      console.log(`turn ${t.turn} (${t.stopReason}): ${calls.join(", ") || "no tool calls"}`);
    },
  });
  console.log(`finished: ${result.manifest.actions.length} steps\n${result.summary}`);
} catch (err) {
  if (!(err instanceof PlanningLoopError && err.reason === "turn_limit")) throw err;
  console.log(`stopped after ${MAX_TURNS} turns, as intended`);
}
console.log(`usage: ${usage.input} input + ${usage.output} output tokens`);
