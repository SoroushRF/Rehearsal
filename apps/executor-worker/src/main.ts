import { primeTokens, workerWorlds } from "@rehearsal/providers";
import { executorCredentialViolations } from "./credentials";

/**
 * Executor worker: deterministic, no model key, no inference in the dispatch path.
 * Holds operational-world capability and consumes approved immutable manifests only.
 * TODO(B): consume "apply" jobs from pg-boss; journal → guard → dispatch → receipt.
 */
const forbidden = executorCredentialViolations();
if (forbidden.length > 0) {
  console.error(`executor-worker must not receive: ${forbidden.join(", ")}`);
  process.exit(1);
}

// Operational tenant tokens, minted by the operator and refreshed before expiry. Mint once at
// startup so a misconfigured minter fails here, not mid-apply.
const worlds = workerWorlds("executor");
await primeTokens(worlds);
console.log(
  `executor-worker ready (stripe=${worlds.stripe.baseUrl}, zendesk=${worlds.zendesk.baseUrl})`,
);
