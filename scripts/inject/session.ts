import { orgTenant } from "@rehearsal/core";
import {
  eraAdmin,
  eraFetch,
  mintTenantToken,
  resolveWorld,
  type WorldConfig,
} from "@rehearsal/providers";
import { INCIDENT, incidentRecords, type SeededCase } from "@rehearsal/testkit";

type World = Parameters<typeof resolveWorld>[1];

/**
 * Operator plumbing for the demo scripts. The admin token and tenant minting stay in
 * scripts/, never in planner code.
 */

export type EraVendor = "stripe" | "zendesk";

function cohortCase(key: string): SeededCase {
  const found = incidentRecords().cases.find((c) => c.key === key);
  if (!found) throw new Error(`incident cohort has no case ${key}`);
  return found;
}

/**
 * The T1.2 cohort cases the traps act on (seeded by `pnpm demo:reset`). They match the fixture
 * plan's cases: the phantom lands on c01 (case_001), the teammate edits c02's ticket (case_002).
 */
export const DEMO = {
  phantom: cohortCase("c01"),
  conflict: cohortCase("c02"),
} as const;

/** The incident window (INC-BILL-0927), in Unix seconds. */
export const WINDOW = {
  createdGte: Date.parse(INCIDENT.window.createdGte) / 1000,
  createdLt: Date.parse(INCIDENT.window.createdLt) / 1000,
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

/** Explicit operator org overrides the legacy shared tenant, just as signed-in workers route it. */
export function demoTenant(
  env: NodeJS.ProcessEnv = process.env,
  args = process.argv.slice(2),
): string | undefined {
  const option = args.find((arg) => arg.startsWith("--org="));
  if (args.includes("--org")) throw new Error("use --org=org_... or DEMO_ORG_ID");
  const orgId = option ? option.slice("--org=".length) : env.DEMO_ORG_ID;
  if (orgId === undefined) return undefined;
  if (!/^org_[A-Za-z0-9]+$/.test(orgId)) throw new Error("invalid demo org ID: expected org_...");
  return orgTenant(orgId);
}

/** A world bound to the selected org or legacy demo tenant with a signed token. */
export async function bind(vendor: EraVendor, world: World): Promise<WorldConfig> {
  const config = resolveWorld(vendor, world, process.env, demoTenant());
  console.log(`${vendor}/${world}: tenant ${config.tenant}`);
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

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Faults hit every org's tenant in the container, so setting one on a shared (non-local) Era would
 * break every judge's run at once. Refused there unless REHEARSAL_SHARED_FAULTS=1. Clearing is
 * always allowed.
 */
export function assertFaultsAllowed(
  world: Pick<WorldConfig, "baseUrl">,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (LOCAL_HOSTS.has(new URL(world.baseUrl).hostname)) return;
  if (env.REHEARSAL_SHARED_FAULTS === "1") return;
  throw new Error(
    `refusing to set container-wide faults on shared Era ${world.baseUrl}: every org's tenant would see them. Set REHEARSAL_SHARED_FAULTS=1 to do it anyway.`,
  );
}

/** Container-wide fault controls. They answer every tenant in that container. */
export async function faults(world: WorldConfig, config: Record<string, unknown> | null) {
  if (config !== null) assertFaultsAllowed(world);
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

/** Print one line per check and set the exit code. */
export function report(checks: Array<[ok: boolean, line: string]>): void {
  for (const [ok, line] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${line}`);
  process.exitCode = checks.every(([ok]) => ok) ? 0 : 1;
}
