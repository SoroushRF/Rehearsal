import { readFileSync } from "node:fs";
import {
  eraAdmin,
  eraFetch,
  mintTenantToken,
  resolveWorld,
  type WorldConfig,
} from "@rehearsal/providers";

type World = Parameters<typeof resolveWorld>[1];

/**
 * Operator plumbing for the demo scripts. The admin token and tenant minting stay in
 * scripts/, never in planner code.
 */

export type EraVendor = "stripe" | "zendesk";

/** Image seed (42, day1, 2026-10-01). Replace with T1's incident cohort once it is seeded. */
export const SEED = {
  customerId: "cus_necGym2uIJ94j40b",
  chargeId: "ch_7wD2ja8lIorW65Uh",
  /** Not the captured ticket template, so a teammate edit does not touch the fixture record. */
  ticketId: 4000001,
} as const;

/** The incident window from the fixture plan: September 2026, UTC. */
export const WINDOW = {
  createdGte: Date.parse("2026-09-01T00:00:00.000Z") / 1000,
  createdLt: Date.parse("2026-10-01T00:00:00.000Z") / 1000,
} as const;

const VENDOR_AUTH: Record<EraVendor, string> = {
  stripe: "Bearer sk_test_rehearsal_demo",
  zendesk: "Bearer rehearsal-demo",
};

export function adminToken(): string {
  const token = process.env.ERA_ADMIN_TOKEN;
  if (!token) throw new Error("ERA_ADMIN_TOKEN is not set (copy .env.example to .env)");
  return token;
}

/** A world bound to the demo tenant with a signed token. A plaintext tenant header is ignored. */
export async function bind(vendor: EraVendor, world: World): Promise<WorldConfig> {
  const config = resolveWorld(vendor, world);
  const { token } = await mintTenantToken(config, adminToken());
  return { ...config, tenantToken: token };
}

export const ALL_WORLDS: ReadonlyArray<{ vendor: EraVendor; world: World }> = [
  { vendor: "stripe", world: "planning" },
  { vendor: "stripe", world: "operational" },
  { vendor: "zendesk", world: "planning" },
  { vendor: "zendesk", world: "operational" },
];

export async function adminOrThrow(
  world: WorldConfig,
  path: string,
  body?: unknown,
): Promise<void> {
  const res = await eraAdmin(world, adminToken(), path, body);
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
}

/** Container-wide fault controls. They answer every tenant in that container. */
export async function faults(world: WorldConfig, config: Record<string, unknown> | null) {
  const path = config === null ? "/_admin/faults/reset" : "/_admin/faults";
  const res = await fetch(`${world.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken()}` },
    body: config === null ? undefined : JSON.stringify(config),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
}

export function vendorFetch(
  vendor: EraVendor,
  world: WorldConfig,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", VENDOR_AUTH[vendor]);
  return eraFetch(world, path, { ...init, headers });
}

export async function getJson<T>(vendor: EraVendor, world: WorldConfig, path: string): Promise<T> {
  const res = await vendorFetch(vendor, world, path);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export function fixture(name: string): Record<string, unknown> {
  const file = new URL(`../../scenarios/billing/fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

/** Print one line per check and set the exit code. */
export function report(checks: Array<[ok: boolean, line: string]>): void {
  for (const [ok, line] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${line}`);
  process.exitCode = checks.every(([ok]) => ok) ? 0 : 1;
}
