import {
  AgentMemoryClient,
  AgentMemoryPrecedents,
  memoryConfigFromEnv,
  precedentScope,
} from "@rehearsal/memory";

/**
 * Precedent recall (#235) for each org, in that org's own scope (decision 0012), with the
 * planner's read-only Agent Memory key (#365). Null when memory isn't configured: an org with
 * active precedents then can't be planned for, and orgs without any plan as before.
 */
export function recallersFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: { fetch?: typeof fetch } = {},
): ((orgId: string) => AgentMemoryPrecedents) | null {
  const memory = memoryConfigFromEnv("read", env);
  if (memory === null) return null;
  const { scope, ...config } = memory;
  const client = new AgentMemoryClient({ ...config, ...options });
  const recallers = new Map<string, AgentMemoryPrecedents>();
  return (orgId) => {
    let recaller = recallers.get(orgId);
    if (!recaller) {
      recaller = new AgentMemoryPrecedents(client, { scope: precedentScope(scope, orgId) });
      recallers.set(orgId, recaller);
    }
    return recaller;
  };
}
