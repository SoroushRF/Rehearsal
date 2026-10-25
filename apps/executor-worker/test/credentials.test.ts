import { expect, it } from "vitest";
import { executorCredentialViolations, executorIamUrlViolations } from "../src/credentials";

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

it("refuses IAM's server certificate", () => {
  expect(
    executorCredentialViolations({
      IAM_TLS_CERT: "infra/iam/dev/server.crt",
      IAM_TLS_KEY: "infra/iam/dev/server.key",
      IAM_TLS_CLIENT_CA: "infra/iam/dev/ca.crt",
    }),
  ).toEqual(["IAM_TLS_CERT", "IAM_TLS_KEY", "IAM_TLS_CLIENT_CA"]);
});

it("needs IAM_URL and still accepts its own client certificate", () => {
  expect(executorIamUrlViolations({})).toEqual(["IAM_URL"]);
  expect(executorIamUrlViolations({ IAM_URL: "" })).toEqual(["IAM_URL"]);
  expect(
    executorCredentialViolations({
      IAM_URL: "https://127.0.0.1:3443",
      IAM_CLIENT_CERT: "infra/iam/dev/executor.crt",
      IAM_CLIENT_KEY: "infra/iam/dev/executor.key",
      IAM_CLIENT_CA: "infra/iam/dev/ca.crt",
    }),
  ).toEqual([]);
  expect(executorIamUrlViolations({ IAM_URL: "https://127.0.0.1:3443" })).toEqual([]);
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
