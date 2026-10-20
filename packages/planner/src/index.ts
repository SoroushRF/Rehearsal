import type { PlannerPort } from "@rehearsal/core";
import { billingManifest } from "@rehearsal/testkit";

/**
 * Owner: A. The real planner is a bounded Claude tool loop over typed planning-world tools
 * (no base URL, tenant, admin path or raw HTTP method is exposed to the model).
 */
export const PROMPT_VERSION = "v0";

/** Stand-in until the tool loop exists: returns the shared fixture plan. */
export const fixturePlanner: PlannerPort = {
  plan: async ({ planId }) => billingManifest(planId),
};
