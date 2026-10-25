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

it("refuses Google model credentials too", () => {
  expect(
    executorCredentialViolations({
      GEMINI_API_KEY: "g",
      GOOGLE_API_KEY: "g",
      GOOGLE_APPLICATION_CREDENTIALS: "C:/adc.json",
    }),
  ).toEqual(["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"]);
});

it("refuses the execution rehearsal's admin token, worker secret and worlds", () => {
  expect(
    executorCredentialViolations({
      REHEARSAL_ERA_ADMIN_TOKEN: "rehearsal-admin",
      REHEARSAL_WORKER_SECRET: "rehearsal-secret",
      ERA_STRIPE_REHEARSAL_URL: "http://127.0.0.1:8103",
      ERA_ZENDESK_REHEARSAL_URL: "http://127.0.0.1:8113",
      ERA_SLACK_REHEARSAL_URL: "http://127.0.0.1:8123",
      REHEARSAL_API_URL: "http://127.0.0.1:3000",
    }),
  ).toEqual([
    "REHEARSAL_ERA_ADMIN_TOKEN",
    "REHEARSAL_WORKER_SECRET",
    "ERA_STRIPE_REHEARSAL_URL",
    "ERA_ZENDESK_REHEARSAL_URL",
    "ERA_SLACK_REHEARSAL_URL",
  ]);
});
