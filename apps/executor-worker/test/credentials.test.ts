import { expect, it } from "vitest";
import { executorCredentialViolations } from "../src/credentials";

it("refuses a model key, the admin token and the planner's minting secret", () => {
  expect(
    executorCredentialViolations({
      ANTHROPIC_API_KEY: "sk-ant-test",
      ERA_ADMIN_TOKEN: "admin",
      PLANNER_WORKER_SECRET: "planner-secret",
    }),
  ).toEqual(["ANTHROPIC_API_KEY", "ERA_ADMIN_TOKEN", "PLANNER_WORKER_SECRET"]);
});

it("starts with operational URLs and its own secret", () => {
  expect(
    executorCredentialViolations({
      ERA_STRIPE_OPERATIONAL_URL: "http://127.0.0.1:8102",
      ERA_ZENDESK_OPERATIONAL_URL: "http://127.0.0.1:8112",
      REHEARSAL_API_URL: "http://127.0.0.1:3000",
      EXECUTOR_WORKER_SECRET: "executor-secret",
    }),
  ).toEqual([]);
});
