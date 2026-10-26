import { ExecutionRehearsalId, type Vendor, type World } from "@rehearsal/contracts";
import { rehearsalTenant } from "@rehearsal/core";
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

/** The environment variable that holds this vendor's URL in this world. */
export function worldEnvKey(vendor: Vendor, world: World): string {
  return ENV_KEYS[vendor][world];
}

/**
 * One vendor's world. `tenant` is an org's own tenant (`orgTenant(orgId)`, #330); without it, the
 * shared tenant (`ERA_TENANT`) that scripts and tests without an org use.
 */
export function resolveWorld(
  vendor: Vendor,
  world: World,
  env: NodeJS.ProcessEnv = process.env,
  tenant?: string,
): WorldConfig {
  const key = ENV_KEYS[vendor][world];
  const baseUrl = env[key];
  if (!baseUrl) throw new Error(`${key} is not set`);
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    tenant: tenant ?? env.ERA_TENANT ?? "rehearsal-demo",
  };
}

/**
 * Execution rehearsal worlds (decision 0013): their own containers, never a planning or
 * operational one. Not a `World`, so nothing that takes a `World` can be pointed at them.
 */
export const REHEARSAL_URL_KEYS: Record<Vendor, string> = {
  stripe: "ERA_STRIPE_REHEARSAL_URL",
  zendesk: "ERA_ZENDESK_REHEARSAL_URL",
  slack: "ERA_SLACK_REHEARSAL_URL",
};

/** Every planning and operational URL variable. */
export const SHARED_URL_KEYS: string[] = Object.values(ENV_KEYS).flatMap((w) => Object.values(w));

/** Host and port, with loopback spellings folded together. */
export function worldEndpoint(url: string): string {
  const u = new URL(url);
  const host = ["localhost", "[::1]"].includes(u.hostname) ? "127.0.0.1" : u.hostname;
  return `${host}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
}

/**
 * The whole routing URL: scheme, endpoint and base path, without a trailing slash. Two worlds can
 * share an endpoint behind a proxy and differ only by path, so host and port can't prove that two
 * URLs reach the same world. Credentials, a query or a fragment are refused.
 */
export function worldUrl(url: string): string {
  const u = new URL(url);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) {
    throw new Error("a world URL is http(s) with no credentials, query or fragment");
  }
  return `${u.protocol}//${worldEndpoint(url)}${u.pathname.replace(/\/+$/, "")}`;
}

/**
 * One rehearsal's tenant in the rehearsal container for a vendor. The tenant is derived from a
 * validated ID, never taken from a caller. A URL that a planning or operational world in the same
 * environment also uses is refused: Era serves a token minted by another container as that
 * container's `default` tenant instead of rejecting it, so the tenant can't keep a misrouted
 * request out of a shared world (docs/capability-matrix.md, surprise 16).
 */
export function resolveRehearsalWorld(
  vendor: Vendor,
  rehearsalId: string,
  env: NodeJS.ProcessEnv = process.env,
): WorldConfig {
  const id = ExecutionRehearsalId.parse(rehearsalId);
  const key = REHEARSAL_URL_KEYS[vendor];
  const raw = env[key];
  if (!raw) throw new Error(`${key} is not set (pnpm infra:up:rehearsal)`);
  const baseUrl = raw.replace(/\/$/, "");
  worldUrl(baseUrl);
  // By endpoint, not full URL: a shared world on the same endpoint under another path is still shared.
  for (const shared of SHARED_URL_KEYS) {
    const other = env[shared];
    if (other && worldEndpoint(other) === worldEndpoint(baseUrl)) {
      throw new Error(`${key} is ${shared}'s world: a rehearsal never runs in a shared world`);
    }
  }
  return { baseUrl, tenant: rehearsalTenant(id) };
}
