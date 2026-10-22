/**
 * The planner worker holds the model key and planning-world capability ONLY. It mints planning
 * tenant tokens through the operator with PLANNER_WORKER_SECRET; it never holds the admin token,
 * operational-world URLs, or the executor's secret (which would mint operational tokens).
 */
export const PLANNER_FORBIDDEN = [
  "ERA_STRIPE_OPERATIONAL_URL",
  "ERA_ZENDESK_OPERATIONAL_URL",
  "ERA_ADMIN_TOKEN",
  "EXECUTOR_WORKER_SECRET",
] as const;

export function plannerCredentialViolations(env: NodeJS.ProcessEnv = process.env): string[] {
  return PLANNER_FORBIDDEN.filter((k) => env[k]);
}
