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

/**
 * Each process holds the one key its job needs (decision 0012 §6, #365): the API syncs precedents
 * with the write key, the planner worker recalls with the read key, and the admin key (minting
 * keys, erasing test scopes) is for operator tools and the memory gate only. The executor and the
 * rehearsal worker hold none. Separate names let each worker refuse the others' at startup; the
 * grants each key is minted with (`memoryKeyGrants`) are what the service enforces.
 */
export const MEMORY_KEY_VARS = {
  read: "SURREAL_AGENT_MEMORY_READ_KEY",
  write: "SURREAL_AGENT_MEMORY_WRITE_KEY",
  admin: "SURREAL_AGENT_MEMORY_ADMIN_KEY",
} as const;
export type MemoryAccess = keyof typeof MEMORY_KEY_VARS;

/** The single key every process used to share. Refused everywhere, so a stale env file is loud. */
export const LEGACY_MEMORY_KEY_VAR = "SURREAL_AGENT_MEMORY_KEY";

/** Every memory key variable, for workers that must hold none. */
export const MEMORY_KEY_ENV = [...Object.values(MEMORY_KEY_VARS), LEGACY_MEMORY_KEY_VAR] as const;

/** What the planner worker refuses: any key that can write or administer memory. */
export const MEMORY_WRITE_KEY_ENV = [
  MEMORY_KEY_VARS.write,
  MEMORY_KEY_VARS.admin,
  LEGACY_MEMORY_KEY_VAR,
] as const;

/**
 * Agent Memory settings for `access` from the environment, or null when none are set (core mode,
 * where `noPrecedents` stands in). Setting only some of them is a mistake, so it throws, and so
 * does the old shared key.
 */
export function memoryConfigFromEnv(
  access: MemoryAccess,
  env: Record<string, string | undefined> = process.env,
): (AgentMemoryConfig & { scope: string }) | null {
  if ((env[LEGACY_MEMORY_KEY_VAR] ?? "") !== "") {
    throw new Error(
      `${LEGACY_MEMORY_KEY_VAR} is no longer read: the API takes ${MEMORY_KEY_VARS.write} and the planner worker ${MEMORY_KEY_VARS.read}`,
    );
  }
  const vars = [
    "SURREAL_AGENT_MEMORY_URL",
    "SURREAL_AGENT_MEMORY_CONTEXT",
    MEMORY_KEY_VARS[access],
  ];
  const set = vars.filter((name) => (env[name] ?? "") !== "");
  if (set.length === 0) return null;
  const missing = vars.filter((name) => !set.includes(name));
  if (missing.length > 0)
    throw new Error(`Agent Memory is partly configured; set ${missing.join(", ")}`);
  return {
    url: env.SURREAL_AGENT_MEMORY_URL as string,
    context: env.SURREAL_AGENT_MEMORY_CONTEXT as string,
    apiKey: env[MEMORY_KEY_VARS[access]] as string,
    scope: env.SURREAL_AGENT_MEMORY_SCOPE || DEFAULT_PRECEDENT_SCOPE,
  };
}

/**
 * The grants each process's key is minted with, under `baseScope` (the scope every org's
 * precedent scope sits below). The API reads back what it writes, so it gets both; the planner
 * only recalls. `scope:create` lets the sync register an org's scope the first time it publishes.
 */
export function memoryKeyGrants(baseScope: string) {
  const below = [`${baseScope}/*`];
  return {
    api: { "memory:read": below, "memory:write": below, "scope:create": below },
    planner: { "memory:read": below },
  } as const;
}

/** The precedent store for this environment, or null in core mode. */
export function precedentsFromEnv(
  access: Exclude<MemoryAccess, "admin">,
  env: Record<string, string | undefined> = process.env,
): AgentMemoryPrecedents | null {
  const config = memoryConfigFromEnv(access, env);
  if (config === null) return null;
  const { scope, ...client } = config;
  return new AgentMemoryPrecedents(new AgentMemoryClient(client), { scope });
}
