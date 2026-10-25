import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// Deployment files are executable Node modules used by Render itself.
// @ts-expect-error deployment module is plain JavaScript
import { blueprint, blueprintText } from "../../../infra/render/blueprint.mjs";
// @ts-expect-error deployment module is plain JavaScript
import { deploymentEnv } from "../../../infra/render/start.mjs";
import { executorCredentialViolations } from "../../executor-worker/src/credentials";
import { plannerCredentialViolations } from "../../planner-worker/src/credentials";
import { rehearsalWorkerConfigViolations } from "../../rehearsal-worker/src/worker";

type Service = {
  name: string;
  type: string;
  envVars: { key: string; value?: string; fromService?: { name: string; envVarKey?: string } }[];
};
const services = blueprint.services as Service[];
function environment(name: string) {
  const config = services.find((s) => s.name === name);
  if (!config) throw new Error(name);
  return Object.fromEntries(
    config.envVars.map((entry) => [
      entry.key,
      entry.value ??
        (entry.key === "DEPLOY_GOOGLE_CREDENTIALS_JSON"
          ? '{"type":"service_account"}'
          : (entry.fromService?.name ?? "test-secret")),
    ]),
  );
}
const writeSecret = (name: string) => `/tmp/${name}`;

describe("Render deployment", () => {
  it("keeps the generated Blueprint synchronized", () => {
    expect(readFileSync(new URL("../../../render.yaml", import.meta.url), "utf8")).toBe(
      blueprintText,
    );
  });
  it("publishes only the API and keeps all nine worlds private", () => {
    expect(services.filter((s) => s.type === "web").map((s) => s.name)).toEqual(["rehearsal-api"]);
    expect(
      services.filter(
        (s) => s.name.match(/-(planning|operational|rehearsal)$/) && s.type === "pserv",
      ),
    ).toHaveLength(9);
    expect(blueprint.databases[0].ipAllowList).toEqual([]);
  });
  it("passes every worker's actual credential boundary after materializing Render references", () => {
    const planner = deploymentEnv("planner", environment("rehearsal-planner"), writeSecret);
    const executor = deploymentEnv("executor", environment("rehearsal-executor"), writeSecret);
    const rehearsal = deploymentEnv("rehearsal", environment("rehearsal-rehearsal"), writeSecret);
    expect(plannerCredentialViolations(planner)).toEqual([]);
    expect(executorCredentialViolations(executor)).toEqual([]);
    expect(rehearsalWorkerConfigViolations(rehearsal)).toEqual([]);
    expect(planner.ERA_STRIPE_PLANNING_URL).toBe("http://rehearsal-stripe-planning:8080");
    expect(executor.IAM_URL).toBe("https://rehearsal-iam:3443");
    expect(planner.GOOGLE_APPLICATION_CREDENTIALS).toBe("/tmp/google.json");
    expect(executor.IAM_CLIENT_KEY).toBe("/tmp/IAM_CLIENT_KEY");
    expect(rehearsal.ERA_STRIPE_REHEARSAL_URL).toBe("http://rehearsal-stripe-rehearsal:8080");
  });
  it("does not silently remove a leaked credential to make a worker boot", () => {
    const env = deploymentEnv(
      "planner",
      { ...environment("rehearsal-planner"), ERA_ADMIN_TOKEN: "leaked" },
      writeSecret,
    );
    expect(plannerCredentialViolations(env)).toContain("ERA_ADMIN_TOKEN");
  });
  it("refuses personal Google login credentials", () => {
    expect(() =>
      deploymentEnv(
        "planner",
        { DEPLOY_GOOGLE_CREDENTIALS_JSON: '{"type":"authorized_user"}' },
        writeSecret,
      ),
    ).toThrow("dedicated service account");
  });
});
