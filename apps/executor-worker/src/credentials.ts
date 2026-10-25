import { REHEARSAL_CREDENTIALS } from "@rehearsal/providers";

/**
 * The executor worker is deterministic: no model key. It mints operational tenant tokens through
 * the operator with EXECUTOR_WORKER_SECRET; it never holds the admin token or the planner's secret.
 */
export const EXECUTOR_FORBIDDEN = [
  // The Clerk secret stays in IAM. The executor asks IAM; it does not verify people itself.
  "CLERK_SECRET_KEY",
  // IAM's server certificate stays on IAM. The executor holds only its client certificate.
  "IAM_TLS_CERT",
  "IAM_TLS_KEY",
  "IAM_TLS_CLIENT_CA",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "ERA_ADMIN_TOKEN",
  "PLANNER_WORKER_SECRET",
  // Execution rehearsal (decision 0013): its admin token, worker secret and worlds.
  ...REHEARSAL_CREDENTIALS,
] as const;

export function executorCredentialViolations(env: NodeJS.ProcessEnv = process.env): string[] {
  return EXECUTOR_FORBIDDEN.filter((k) => env[k]);
}

/** Set when this process has nowhere to ask `run:admit`. The worker does not boot without it. */
export function executorIamUrlViolations(env: NodeJS.ProcessEnv = process.env): string[] {
  return env.IAM_URL ? [] : ["IAM_URL"];
}
