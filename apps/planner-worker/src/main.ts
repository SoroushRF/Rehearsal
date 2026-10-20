import { PROMPT_VERSION } from "@rehearsal/planner";

/**
 * Planner worker: holds the model key and planning-world capability ONLY.
 * No operational-world URLs, no Era admin token, no executor code.
 * TODO(A): consume "plan" jobs from pg-boss and run the bounded tool loop.
 */
const forbidden = [
  "ERA_STRIPE_OPERATIONAL_URL",
  "ERA_ZENDESK_OPERATIONAL_URL",
  "ERA_ADMIN_TOKEN",
].filter((k) => process.env[k]);
if (forbidden.length > 0) {
  console.error(`planner-worker must not receive: ${forbidden.join(", ")}`);
  process.exit(1);
}

console.log(`planner-worker ready (prompt ${PROMPT_VERSION})`);
