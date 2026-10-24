import type { Vendor, World } from "@rehearsal/contracts";
import type { TokenSource } from "./tenant-tokens";

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
   * Workers get a refreshing {@link TokenSource}; a source that throws stops the request.
   */
  tenantToken?: string | TokenSource;
}

const ENV_KEYS: Record<Vendor, Record<World, string>> = {
  stripe: { planning: "ERA_STRIPE_PLANNING_URL", operational: "ERA_STRIPE_OPERATIONAL_URL" },
  zendesk: { planning: "ERA_ZENDESK_PLANNING_URL", operational: "ERA_ZENDESK_OPERATIONAL_URL" },
  // Full extension (T3.10): only workers that post the run summary need these set.
  slack: { planning: "ERA_SLACK_PLANNING_URL", operational: "ERA_SLACK_OPERATIONAL_URL" },
};

export function resolveWorld(
  vendor: Vendor,
  world: World,
  env: NodeJS.ProcessEnv = process.env,
): WorldConfig {
  const key = ENV_KEYS[vendor][world];
  const baseUrl = env[key];
  if (!baseUrl) throw new Error(`${key} is not set`);
  return { baseUrl: baseUrl.replace(/\/$/, ""), tenant: env.ERA_TENANT ?? "rehearsal-demo" };
}
