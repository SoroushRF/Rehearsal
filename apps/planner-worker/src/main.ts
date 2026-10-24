import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import type { BillingPolicyV1 } from "@rehearsal/core";
import { DEFAULT_PLANNER_MODEL, PROMPT_VERSION } from "@rehearsal/planner";
import {
  plannerJobsClient,
  primeTokens,
  STRIPE_CHARGE_PROJECTION,
  stripeReader,
  workerWorlds,
  ZENDESK_TICKET_PROJECTION,
  zendeskReader,
} from "@rehearsal/providers";
import policy from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import { plannerCredentialViolations } from "./credentials";
import { geminiMessagesClient } from "./gemini";
import { handlePlanJob } from "./job";

/**
 * Planner worker: holds the model key and planning-world capability ONLY. No operational-world
 * URLs, no Era admin token, no database, no executor code. It takes `plan` jobs from the API with
 * its own secret, plans in the planning world, and hands the manifest back to the API.
 */
const forbidden = plannerCredentialViolations();
if (forbidden.length > 0) {
  console.error(`planner-worker must not receive: ${forbidden.join(", ")}`);
  process.exit(1);
}
const secret = process.env.PLANNER_WORKER_SECRET;
const apiUrl = process.env.REHEARSAL_API_URL;
const model = process.env.PLANNER_MODEL || DEFAULT_PLANNER_MODEL;
// A Gemini model runs on Vertex AI with the worker's Google credentials (ADC); Claude needs a key.
const gemini = model.startsWith("gemini-");
const project = process.env.GOOGLE_CLOUD_PROJECT;
if (!secret || !apiUrl || (gemini ? !project : !process.env.ANTHROPIC_API_KEY)) {
  console.error(
    `planner-worker needs REHEARSAL_API_URL, PLANNER_WORKER_SECRET and ${gemini ? "GOOGLE_CLOUD_PROJECT" : "ANTHROPIC_API_KEY"}`,
  );
  process.exit(1);
}

// Mint once at startup so a misconfigured minter fails here, not mid-plan.
const worlds = workerWorlds("planner");
await primeTokens(worlds);
if (worlds.stripe.tenant !== worlds.zendesk.tenant) {
  console.error("planner-worker expects one planning tenant for Stripe and Zendesk");
  process.exit(1);
}

// The simulators accept any bearer; real read-only credentials would come from the environment.
// A read that times out comes back to the model as a failed read; the run's deadline still holds.
const READ_TIMEOUT_MS = 30_000;
const readers = {
  stripe: stripeReader({
    world: "planning",
    config: worlds.stripe,
    authorization: "Bearer sk_test_rehearsal_planner",
    timeoutMs: READ_TIMEOUT_MS,
  }),
  zendesk: zendeskReader({
    world: "planning",
    config: worlds.zendesk,
    authorization: "Bearer rehearsal-planner",
    timeoutMs: READ_TIMEOUT_MS,
  }),
};
const client = gemini
  ? geminiMessagesClient(
      new GoogleGenAI({
        vertexai: true,
        project,
        location: process.env.GOOGLE_CLOUD_LOCATION || "global",
      }).models,
    )
  : new Anthropic().messages;
const jobs = plannerJobsClient(apiUrl, secret);
const ctx = {
  jobs,
  client,
  model,
  readers,
  ctx: { world: "planning", tenant: worlds.stripe.tenant } as const,
  policy: policy as BillingPolicyV1,
  adapters: { stripe: STRIPE_CHARGE_PROJECTION, zendesk: ZENDESK_TICKET_PROJECTION },
  // The run summary's channel (T1.7). The planner only names it; the executor posts.
  summaryChannelId: process.env.RUN_SUMMARY_CHANNEL || undefined,
  // Public replies to customers (T1.13). Off unless CUSTOMER_REPLIES=1.
  customerReplies: process.env.CUSTOMER_REPLIES === "1",
  log: (line: string) => console.log(line),
};

const IDLE_POLL_MS = 2_000;
const ERROR_BACKOFF_MS = 10_000;
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  // A run in progress finishes (it is bounded); an unfinished one expires and is retried.
  process.once(signal, () => {
    stopping = true;
  });
}

console.log(
  `planner-worker ready: ${model}, prompt ${PROMPT_VERSION}, planning ${worlds.stripe.baseUrl} + ${worlds.zendesk.baseUrl}`,
);
while (!stopping) {
  try {
    const job = await jobs.next();
    if (job) await handlePlanJob(job, ctx);
    else await new Promise((r) => setTimeout(r, IDLE_POLL_MS));
  } catch (err) {
    console.error("planner-worker:", (err as Error).message);
    await new Promise((r) => setTimeout(r, ERROR_BACKOFF_MS));
  }
}
process.exit(0);
