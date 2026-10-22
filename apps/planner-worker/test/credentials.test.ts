import { expect, it } from "vitest";
import { plannerCredentialViolations } from "../src/credentials";

it("refuses operational URLs, the admin token and the executor's minting secret", () => {
  expect(
    plannerCredentialViolations({
      ERA_STRIPE_OPERATIONAL_URL: "http://127.0.0.1:8102",
      ERA_ZENDESK_OPERATIONAL_URL: "http://127.0.0.1:8112",
      ERA_ADMIN_TOKEN: "admin",
      EXECUTOR_WORKER_SECRET: "executor-secret",
    }),
  ).toEqual([
    "ERA_STRIPE_OPERATIONAL_URL",
    "ERA_ZENDESK_OPERATIONAL_URL",
    "ERA_ADMIN_TOKEN",
    "EXECUTOR_WORKER_SECRET",
  ]);
});

it("starts with the model key, planning URLs and its own secret", () => {
  expect(
    plannerCredentialViolations({
      ANTHROPIC_API_KEY: "sk-ant-test",
      ERA_STRIPE_PLANNING_URL: "http://127.0.0.1:8101",
      ERA_ZENDESK_PLANNING_URL: "http://127.0.0.1:8111",
      REHEARSAL_API_URL: "http://127.0.0.1:3000",
      PLANNER_WORKER_SECRET: "planner-secret",
    }),
  ).toEqual([]);
});
