import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import type { World } from "@rehearsal/contracts";
import {
  eraAdmin,
  eraFetch,
  mintTenantToken,
  resolveWorld,
  type WorldConfig,
} from "@rehearsal/providers";

/**
 * Shared plumbing for the pinned-image conformance suites. Every suite runs in throwaway tenants
 * bound by a signed token (never the shared "default" tenant), and resets them afterwards.
 */

const ROOT = new URL("../../../", import.meta.url);

export const ENABLED = process.env.ERA_CONFORMANCE === "1";

if (ENABLED && existsSync(new URL(".env", ROOT))) process.loadEnvFile(new URL(".env", ROOT));

export type EraVendor = "stripe" | "zendesk";
/** Slack is a full extension: only the helpers its suites use take it. */
export type HarnessVendor = EraVendor | "slack";

/** The Slack worlds only run with `pnpm infra:up:full`; their suites also need ERA_SLACK=1. */
export const SLACK_ENABLED = ENABLED && process.env.ERA_SLACK === "1";

/** The execution-rehearsal worlds only run with `pnpm infra:up:rehearsal`; their suites also need ERA_REHEARSAL=1. */
export const REHEARSAL_ENABLED = ENABLED && process.env.ERA_REHEARSAL === "1";

/** Seeded records (seed 42, day1, 2026-10-01). Suites assert their preconditions first. */
export const SEED = {
  /** Succeeded USD charge, no refunds, not disputed. */
  chargeId: "ch_7wD2ja8lIorW65Uh",
  customerId: "cus_necGym2uIJ94j40b",
  /** Open ticket with public and private comments. */
  ticketId: 4000000,
  /** Second ticket, so suites that write don't contend over one record. */
  otherTicketId: 4000001,
} as const;

export function adminToken(): string {
  const token = process.env.ERA_ADMIN_TOKEN;
  if (!token) throw new Error("ERA_ADMIN_TOKEN is not set (copy .env.example to .env)");
  return token;
}

/** The simulators accept any bearer; Stripe's /_meta advertises the sk_test_ shape. */
const VENDOR_AUTH: Record<HarnessVendor, string> = {
  stripe: "Bearer sk_test_rehearsal_conformance",
  zendesk: "Bearer rehearsal-conformance",
  slack: "Bearer xoxb-rehearsal-conformance",
};

const scratch: WorldConfig[] = [];

export function uniqueTenant(label: string): string {
  return `conf-${label}-${randomBytes(4).toString("hex")}`;
}

/** A world bound to a fresh signed tenant. Reset by {@link resetScratchTenants}. */
export async function scratchWorld(
  vendor: HarnessVendor,
  world: World,
  tenant: string,
): Promise<WorldConfig> {
  const cfg: WorldConfig = { ...resolveWorld(vendor, world), tenant };
  const { token } = await mintTenantToken(cfg, adminToken());
  const bound = { ...cfg, tenantToken: token };
  scratch.push(bound);
  return bound;
}

export async function resetTenant(world: WorldConfig): Promise<void> {
  const res = await eraAdmin(world, adminToken(), "/reset");
  if (!res.ok) throw new Error(`reset ${world.tenant} → ${res.status} ${await res.text()}`);
}

export async function resetScratchTenants(): Promise<void> {
  for (const world of scratch.splice(0)) await resetTenant(world);
}

export function vendorFetch(
  vendor: HarnessVendor,
  world: WorldConfig,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", VENDOR_AUTH[vendor]);
  return eraFetch(world, path, { ...init, headers });
}

export async function getJson<T = Record<string, unknown>>(
  vendor: HarnessVendor,
  world: WorldConfig,
  path: string,
): Promise<T> {
  const res = await vendorFetch(vendor, world, path);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** Stripe form POST with the body sent as the exact bytes given (the idempotency fingerprint). */
export function stripePost(
  world: WorldConfig,
  path: string,
  body: string,
  idempotencyKey?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  return vendorFetch("stripe", world, path, { method: "POST", headers, body });
}

export function zendeskPutTicket(
  world: WorldConfig,
  ticketId: number,
  ticket: Record<string, unknown>,
): Promise<Response> {
  return vendorFetch("zendesk", world, `/api/v2/tickets/${ticketId}.json`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket }),
  });
}

export interface ZendeskTicket {
  id: number;
  priority: string | null;
  updated_at: string;
  [key: string]: unknown;
}

export interface ZendeskComment {
  id: number;
  body: string;
  public: boolean;
  author_id: number;
  created_at: string;
}

export async function getTicket(world: WorldConfig, id: number): Promise<ZendeskTicket> {
  return (await getJson<{ ticket: ZendeskTicket }>("zendesk", world, `/api/v2/tickets/${id}.json`))
    .ticket;
}

export async function getComments(world: WorldConfig, id: number): Promise<ZendeskComment[]> {
  const body = await getJson<{ comments: ZendeskComment[]; next_page: string | null }>(
    "zendesk",
    world,
    `/api/v2/tickets/${id}/comments.json`,
  );
  if (body.next_page) throw new Error(`ticket ${id} has more than one page of comments`);
  return body.comments;
}

/** Image references exactly as pinned in infra/compose.yaml, so the suites follow the pin. */
export function pinnedImage(vendor: EraVendor): string {
  const compose = readFileSync(new URL("infra/compose.yaml", ROOT), "utf8");
  const match = compose.match(new RegExp(`erabyeon/${vendor}@sha256:[0-9a-f]{64}`));
  if (!match) throw new Error(`no pinned erabyeon/${vendor} digest in infra/compose.yaml`);
  return match[0];
}

const exec = promisify(execFile);

/**
 * One-off container from the pinned image with the compose settings, minus
 * SIMCORE_ALLOW_CLIENT_WRITES: the read-only refusal control.
 */
export async function startReadOnlySimulator(
  vendor: EraVendor,
): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  const { stdout } = await exec("docker", [
    "run",
    "-d",
    "--rm",
    "-p",
    "127.0.0.1::8080",
    "-e",
    "SIMCORE_SEED=42",
    "-e",
    "SIMCORE_TODAY=2026-10-01",
    "-e",
    "SIMCORE_STATE=day1",
    "-e",
    "SIMCORE_FIDELITY=high",
    "-e",
    `SIMCORE_ADMIN_TOKEN=${adminToken()}`,
    pinnedImage(vendor),
  ]);
  const id = stdout.trim();
  const stop = async () => {
    await exec("docker", ["stop", id]).catch(() => {});
  };
  try {
    const port = (await exec("docker", ["port", id, "8080/tcp"])).stdout.trim().split(":").pop();
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 60_000;
    for (;;) {
      const up = await fetch(`${baseUrl}/_meta`).then(
        (r) => r.ok,
        () => false,
      );
      if (up) return { baseUrl, stop };
      if (Date.now() > deadline) throw new Error(`${vendor} read-only control never came up`);
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch (e) {
    await stop();
    throw e;
  }
}
