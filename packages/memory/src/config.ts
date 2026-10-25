import { createHash } from "node:crypto";
import { AgentMemoryClient, type AgentMemoryConfig } from "./client";
import { AgentMemoryPrecedents } from "./precedents";

export const DEFAULT_PRECEDENT_SCOPE = "rehearsal/precedents";

/**
 * One memory scope per organization (decision 0012): a shared scope would let one organization's
 * planner recall another's precedents. Clerk org IDs are mixed case and the service takes only
 * lowercase paths, so the scope carries a hash of the ID instead. The sync writes here and the
 * planner recalls from here, so both must build it this way.
 */
export function precedentScope(baseScope: string, orgId: string): string {
  return `${baseScope}/org-${createHash("sha256").update(orgId).digest("hex").slice(0, 16)}`;
}

const VARS = [
  "SURREAL_AGENT_MEMORY_URL",
  "SURREAL_AGENT_MEMORY_CONTEXT",
  "SURREAL_AGENT_MEMORY_KEY",
] as const;

/**
 * Agent Memory settings from the environment, or null when none are set (core mode, where
 * `noPrecedents` stands in). Setting only some of them is a mistake, so it throws.
 */
export function memoryConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): (AgentMemoryConfig & { scope: string }) | null {
  const set = VARS.filter((name) => (env[name] ?? "") !== "");
  if (set.length === 0) return null;
  const missing = VARS.filter((name) => !set.includes(name));
  if (missing.length > 0)
    throw new Error(`Agent Memory is partly configured; set ${missing.join(", ")}`);
  return {
    url: env.SURREAL_AGENT_MEMORY_URL as string,
    context: env.SURREAL_AGENT_MEMORY_CONTEXT as string,
    apiKey: env.SURREAL_AGENT_MEMORY_KEY as string,
    scope: env.SURREAL_AGENT_MEMORY_SCOPE || DEFAULT_PRECEDENT_SCOPE,
  };
}

/** The precedent store for this environment, or null in core mode. */
export function precedentsFromEnv(
  env: Record<string, string | undefined> = process.env,
): AgentMemoryPrecedents | null {
  const config = memoryConfigFromEnv(env);
  if (config === null) return null;
  const { scope, ...client } = config;
  return new AgentMemoryPrecedents(new AgentMemoryClient(client), { scope });
}
