import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Render service references provide hostnames, not interpolated URLs. Materialize only the
// current role's certificate/key. No shared env group or inherited operator .env is loaded.
export function deploymentEnv(role, source = process.env, writeSecret) {
  const env = { ...source };
  for (const [key, host] of Object.entries(source)) {
    if (/^ERA_(STRIPE|ZENDESK|SLACK)_(PLANNING|OPERATIONAL|REHEARSAL)_HOST$/.test(key) && host) {
      env[key.replace(/_HOST$/, "_URL")] = `http://${host}:8080`;
      delete env[key];
    }
  }
  if (env.REHEARSAL_API_HOST) {
    env.REHEARSAL_API_URL = `http://${env.REHEARSAL_API_HOST}:10000`;
    delete env.REHEARSAL_API_HOST;
  }
  if (env.REHEARSAL_IAM_HOST) {
    env.IAM_URL = `https://${env.REHEARSAL_IAM_HOST}:3443`;
    delete env.REHEARSAL_IAM_HOST;
  }
  if (["api", "executor", "iam"].includes(role)) {
    const name = role === "iam" ? "SERVER" : role.toUpperCase();
    const pairs =
      role === "iam"
        ? [
            ["IAM_TLS_CERT", `DEPLOY_${name}_CERT_PEM`],
            ["IAM_TLS_KEY", `DEPLOY_${name}_KEY_PEM`],
            ["IAM_TLS_CLIENT_CA", "DEPLOY_IAM_CA_PEM"],
          ]
        : [
            ["IAM_CLIENT_CERT", `DEPLOY_${name}_CERT_PEM`],
            ["IAM_CLIENT_KEY", `DEPLOY_${name}_KEY_PEM`],
            ["IAM_CLIENT_CA", "DEPLOY_IAM_CA_PEM"],
          ];
    for (const [target, key] of pairs) {
      if (!env[key]) throw new Error(`missing ${key}`);
      env[target] = writeSecret(target, env[key]);
      delete env[key];
    }
  }
  if (role === "planner") {
    if (!env.DEPLOY_GOOGLE_CREDENTIALS_JSON)
      throw new Error("missing dedicated Google service account");
    const account = JSON.parse(env.DEPLOY_GOOGLE_CREDENTIALS_JSON);
    if (account.type !== "service_account")
      throw new Error("only a dedicated service account is accepted");
    env.GOOGLE_APPLICATION_CREDENTIALS = writeSecret(
      "google.json",
      env.DEPLOY_GOOGLE_CREDENTIALS_JSON,
    );
    delete env.DEPLOY_GOOGLE_CREDENTIALS_JSON;
  }
  if (env.RENDER_GIT_COMMIT) env.GIT_COMMIT = env.RENDER_GIT_COMMIT;
  return env;
}

const packages = {
  api: "api",
  iam: "iam",
  planner: "planner-worker",
  executor: "executor-worker",
  rehearsal: "rehearsal-worker",
};
export function materializeEnv(role, source = process.env) {
  const dir = mkdtempSync(join(tmpdir(), "rehearsal-secrets-"));
  return deploymentEnv(role, source, (name, contents) => {
    const path = join(dir, name);
    writeFileSync(path, contents, { mode: 0o600 });
    return path;
  });
}
if (process.argv[1]?.replaceAll("\\", "/").endsWith("/infra/render/start.mjs")) {
  const role = process.argv[2];
  if (!Object.hasOwn(packages, role))
    throw new Error("expected api, iam, planner, executor or rehearsal");
  const env = materializeEnv(role);
  const child = spawn(process.execPath, ["--import", "tsx", `apps/${packages[role]}/src/main.ts`], {
    env,
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
