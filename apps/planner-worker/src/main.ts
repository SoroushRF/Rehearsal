import { PROMPT_VERSION } from "@rehearsal/planner";
import { primeTokens, workerWorlds } from "@rehearsal/providers";
import { plannerCredentialViolations } from "./credentials";

/**
 * Planner worker: holds the model key and planning-world capability ONLY.
 * No operational-world URLs, no Era admin token, no executor code.
 * TODO(A): consume "plan" jobs from pg-boss and run the bounded tool loop.
 */
const forbidden = plannerCredentialViolations();
if (forbidden.length > 0) {
  console.error(`planner-worker must not receive: ${forbidden.join(", ")}`);
  process.exit(1);
}

// Mint once at startup so a misconfigured minter fails here, not mid-plan.
const worlds = workerWorlds("planner");
await primeTokens(worlds);
console.log(`planner-worker ready (prompt ${PROMPT_VERSION})`);
