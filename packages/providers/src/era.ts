import type { WorldConfig } from "./worlds";

/** Subset of GET /_meta we rely on. */
export interface EraMeta {
  writes?: { allowed?: boolean };
  [key: string]: unknown;
}

/** Client-side request to a simulator world, scoped to its tenant. */
export async function eraFetch(
  world: WorldConfig,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-Sim-Tenant", world.tenant);
  return fetch(`${world.baseUrl}${path}`, { ...init, headers });
}

export async function eraMeta(world: WorldConfig): Promise<EraMeta> {
  const res = await eraFetch(world, "/_meta");
  if (!res.ok) throw new Error(`GET /_meta → ${res.status}`);
  return (await res.json()) as EraMeta;
}

/**
 * Operator-only admin calls (/_admin: inject, reset, faults). Lives here for scripts and tests;
 * the planner worker must never be given an admin token.
 */
export async function eraAdmin(
  world: WorldConfig,
  adminToken: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${world.baseUrl}/_admin/tenants/${encodeURIComponent(world.tenant)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
