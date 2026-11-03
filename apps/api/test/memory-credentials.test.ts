import { LEGACY_MEMORY_KEY_VAR, MEMORY_KEY_ENV, MEMORY_KEY_VARS } from "@rehearsal/memory";
import { expect, it } from "vitest";
import { executorCredentialViolations } from "../../executor-worker/src/credentials";
import { plannerCredentialViolations } from "../../planner-worker/src/credentials";
import { rehearsalWorkerConfigViolations } from "../../rehearsal-worker/src/worker";

// The executor and rehearsal workers list the memory key names themselves (they don't depend on
// @rehearsal/memory). This keeps them equal to the memory package's, so a new key is refused too.
const holding = (key: string) => ({ [key]: "sp-key" });

it("keeps every Agent Memory key out of the executor and the rehearsal worker (#365)", () => {
  for (const key of MEMORY_KEY_ENV) {
    expect(executorCredentialViolations(holding(key))).toEqual([key]);
    expect(rehearsalWorkerConfigViolations(holding(key))).toContain(`must not hold ${key}`);
  }
});

it("lets the planner hold only the read key", () => {
  expect(plannerCredentialViolations(holding(MEMORY_KEY_VARS.read))).toEqual([]);
  for (const key of [MEMORY_KEY_VARS.write, MEMORY_KEY_VARS.admin, LEGACY_MEMORY_KEY_VAR]) {
    expect(plannerCredentialViolations(holding(key))).toEqual([key]);
  }
});
