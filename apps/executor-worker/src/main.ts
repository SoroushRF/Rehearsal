import { resolveWorld } from "@rehearsal/providers";

/**
 * Executor worker: deterministic, no model key, no inference in the dispatch path.
 * Holds operational-world capability and consumes approved immutable manifests only.
 * TODO(B): consume "apply" jobs from pg-boss; journal → guard → dispatch → receipt.
 */
if (process.env.ANTHROPIC_API_KEY) {
  console.error("executor-worker must not receive ANTHROPIC_API_KEY");
  process.exit(1);
}

const worlds = {
  stripe: resolveWorld("stripe", "operational"),
  zendesk: resolveWorld("zendesk", "operational"),
};
console.log(
  `executor-worker ready (stripe=${worlds.stripe.baseUrl}, zendesk=${worlds.zendesk.baseUrl})`,
);
