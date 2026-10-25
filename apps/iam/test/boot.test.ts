import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { iamClientViolations, iamServerViolations, plannerIamViolations } from "../src/boot";
import { generateDevCerts } from "../src/dev-certs";

const root = resolve(import.meta.dirname, "../../..");

function runMain(
  script: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(join(root, "node_modules/.bin/tsx"), [script], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => resolvePromise({ code, stderr }));
  });
}

describe("boot", () => {
  it("names missing certificate files and a planner that can reach IAM", () => {
    expect(iamServerViolations({})).toEqual(["IAM_TLS_CERT", "IAM_TLS_KEY", "IAM_TLS_CLIENT_CA"]);
    expect(iamClientViolations({})).toEqual(["IAM_CLIENT_CERT", "IAM_CLIENT_KEY", "IAM_CLIENT_CA"]);
    expect(plannerIamViolations({ IAM_URL: "https://127.0.0.1:3443" })).toEqual(["IAM_URL"]);
    const certs = generateDevCerts(mkdtempSync(join(tmpdir(), "iam-boot-")));
    expect(
      iamServerViolations({
        IAM_TLS_CERT: certs.serverCert,
        IAM_TLS_KEY: certs.serverKey,
        IAM_TLS_CLIENT_CA: certs.ca,
      }),
    ).toEqual([]);
  });

  it("IAM, the API and the executor refuse to boot without certificates", async () => {
    const iam = await runMain("apps/iam/src/main.ts", {});
    expect(iam.code).toBe(1);
    expect(iam.stderr).toContain("IAM_TLS_CERT");

    const api = await runMain("apps/api/src/main.ts", {});
    expect(api.code).toBe(1);
    expect(api.stderr).toContain("IAM_CLIENT_CERT");

    const executor = await runMain("apps/executor-worker/src/main.ts", {});
    expect(executor.code).toBe(1);
    expect(executor.stderr).toContain("IAM_CLIENT_CERT");
  }, 40_000);

  it("the planner refuses a client certificate or an IAM url", async () => {
    const planner = await runMain("apps/planner-worker/src/main.ts", {
      IAM_URL: "https://127.0.0.1:3443",
    });
    expect(planner.code).toBe(1);
    expect(planner.stderr).toContain("IAM_URL");
  }, 20_000);
});
