import type { PlannerPort } from "@rehearsal/core";
import { billingManifest } from "@rehearsal/testkit";

/**
 * The planner is a bounded Claude tool loop (`runPlanningLoop`) over typed planning-world tools
 * (`PlanningSession`). No base URL, tenant, admin path or raw HTTP method is exposed to the model.
 */

/** Fixture stand-in for tests and demos without a model key: returns the shared fixture plan. */
export const fixturePlanner: PlannerPort = {
  plan: async ({ planId }) => billingManifest(planId),
};

export * from "./brief";
export * from "./coverage";
export * from "./loop";
export * from "./model-retry";
export * from "./prompt";
export * from "./tools";
