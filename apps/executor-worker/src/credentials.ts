/**
 * The executor worker is deterministic: no model key. It mints operational tenant tokens through
 * the operator with EXECUTOR_WORKER_SECRET; it never holds the admin token or the planner's secret.
 */
export const EXECUTOR_FORBIDDEN = [
  "ANTHROPIC_API_KEY",
  "ERA_ADMIN_TOKEN",
  "PLANNER_WORKER_SECRET",
] as const;

export function executorCredentialViolations(env: NodeJS.ProcessEnv = process.env): string[] {
  return EXECUTOR_FORBIDDEN.filter((k) => env[k]);
}
