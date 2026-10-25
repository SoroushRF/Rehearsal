import type { WorldConfig } from "./worlds";

/** Subset of GET /_meta we rely on. */
export interface EraMeta {
  writes?: { allowed?: boolean };
  [key: string]: unknown;
}

/**
 * Simulators never redirect. A followed redirect would carry the tenant token or admin token to a
 * URL no world check looked at, so every request here fails on one instead (a write's transport
 * failure is an unknown outcome, reconciled by reads).
 */
export const NO_REDIRECTS = { redirect: "error" } as const satisfies RequestInit;

/** Client-side request to a simulator world, scoped to its tenant. */
export async function eraFetch(
  world: WorldConfig,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  // A plaintext tenant name only selects a tenant on an unsecured simulator; the signed token
  // selects it everywhere. A token source that cannot produce a token throws before any request.
  const token =
    typeof world.tenantToken === "object" ? await world.tenantToken.get() : world.tenantToken;
  headers.set("X-Sim-Tenant", token ?? world.tenant);
  return fetch(`${world.baseUrl}${path}`, { ...init, headers, ...NO_REDIRECTS });
}

/**
 * Operator-only: mint a tenant-bound credential from the simulator's built-in IdP
 * (client_credentials grant naming the tenant). Tokens are RS256 JWTs carrying a signed `tenant`
 * claim, valid for `expires_in` seconds (3600 on the pinned images), and survive a tenant reset.
 * Each container signs its own, so mint once per world.
 */
export async function mintTenantToken(
  world: WorldConfig,
  adminToken: string,
): Promise<{ token: string; expiresAt: number }> {
  const res = await fetch(`${world.baseUrl}/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-sim-admin-token": adminToken,
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: `rehearsal-${world.tenant}`,
      client_secret: "rehearsal",
      tenant: world.tenant,
    }),
    ...NO_REDIRECTS,
  });
  if (!res.ok) throw new Error(`POST /token → ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  return { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
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
    ...NO_REDIRECTS,
  });
}
