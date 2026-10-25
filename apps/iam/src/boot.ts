import { existsSync } from "node:fs";

/** What the API and the executor need to call IAM. The planner must have none of these. */
export const IAM_CLIENT_ENV = [
  "IAM_CLIENT_CERT",
  "IAM_CLIENT_KEY",
  "IAM_CLIENT_CA",
  "IAM_URL",
] as const;

/** What IAM itself needs before it listens. A missing one means it does not boot. */
export const IAM_SERVER_ENV = ["IAM_TLS_CERT", "IAM_TLS_KEY", "IAM_TLS_CLIENT_CA"] as const;

function missingFiles(env: NodeJS.ProcessEnv, keys: readonly string[]): string[] {
  return keys.filter((key) => {
    const path = env[key];
    return !path || !existsSync(path);
  });
}

/** Names of the server certificate files that are unset or not on disk. */
export function iamServerViolations(env: NodeJS.ProcessEnv = process.env): string[] {
  return missingFiles(env, IAM_SERVER_ENV);
}

/** Names of the client certificate files that are unset or not on disk. */
export function iamClientViolations(env: NodeJS.ProcessEnv = process.env): string[] {
  return missingFiles(env, ["IAM_CLIENT_CERT", "IAM_CLIENT_KEY", "IAM_CLIENT_CA"]);
}

/**
 * Set when this process has a way to reach IAM. The planner must have none: no client certificate
 * and no URL. Empty values do not count.
 */
export function plannerIamViolations(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...IAM_CLIENT_ENV, ...IAM_SERVER_ENV].filter((key) => env[key]);
}
