import type { Vendor, World } from "@rehearsal/contracts";

/**
 * World URLs are chosen by the server from its own environment — never by the planner or browser.
 * Each (vendor, world) pair is its own container, because Era fault settings are container-wide.
 */
export interface WorldConfig {
  baseUrl: string;
  tenant: string;
  /**
   * Signed tenant credential from {@link mintTenantToken}. A simulator with SIMCORE_ADMIN_TOKEN
   * set ignores a plaintext X-Sim-Tenant from clients and serves the "default" tenant, so without
   * this every client request in a world shares one tenant. See docs/capability-matrix.md.
   */
  tenantToken?: string;
}

const ENV_KEYS: Record<Exclude<Vendor, "slack">, Record<World, string>> = {
  stripe: { planning: "ERA_STRIPE_PLANNING_URL", operational: "ERA_STRIPE_OPERATIONAL_URL" },
  zendesk: { planning: "ERA_ZENDESK_PLANNING_URL", operational: "ERA_ZENDESK_OPERATIONAL_URL" },
};

export function resolveWorld(
  vendor: Exclude<Vendor, "slack">,
  world: World,
  env: NodeJS.ProcessEnv = process.env,
): WorldConfig {
  const key = ENV_KEYS[vendor][world];
  const baseUrl = env[key];
  if (!baseUrl) throw new Error(`${key} is not set`);
  return { baseUrl: baseUrl.replace(/\/$/, ""), tenant: env.ERA_TENANT ?? "rehearsal-demo" };
}
