import { orgTenant } from "@rehearsal/core";
import { APPLY_QUEUE, type Db, OrgWorldBusy, PLAN_QUEUE, withOrgWorlds } from "@rehearsal/db";
import {
  eraFetch,
  mintTenantToken,
  resolveWorld,
  type WorkerRole,
  type WorldConfig,
} from "@rehearsal/providers";
import { incidentRecords } from "@rehearsal/testkit";
import { sql } from "drizzle-orm";
import { adminOrThrow } from "../../../scripts/inject/session";
import { seedIncident } from "../../../scripts/seed/incident";

/**
 * Live demo (#330): each org has its own Era tenant, `orgTenant(orgId)`, in the planning and the
 * operational worlds, so one org's apply never changes another org's data. The API is the operator
 * (it alone holds ERA_ADMIN_TOKEN): it seeds new tenants, and it mints a worker a token for an
 * org's tenant only while that worker has work for that org.
 */

/** Whether this worker's own queue has a job for the org that isn't finished. */
export async function workerHasWork(
  db: Pick<Db, "execute">,
  role: WorkerRole,
  orgId: string,
): Promise<boolean> {
  const queue = role === "planner" ? PLAN_QUEUE : APPLY_QUEUE;
  const rows = await db.execute(
    sql`select 1 from pgboss.job where name = ${queue} and state in ('created', 'retry', 'active') and data->>'orgId' = ${orgId} limit 1`,
  );
  return rows.rows.length > 0;
}

/** Hold admission closed from the idle check until the reset finishes, across API processes. */
export function resetIdleOrgWorlds(
  db: Db,
  orgId: string,
  reset: (orgId: string) => Promise<void> = resetOrgWorlds,
): Promise<void> {
  return withOrgWorlds(db, orgId, async (tx) => {
    if (
      (await workerHasWork(tx, "planner", orgId)) ||
      (await workerHasWork(tx, "executor", orgId))
    ) {
      throw new OrgWorldBusy();
    }
    // A crashed worker may still owe recovery even when its queue job has expired.
    const { rows } = await tx.execute(sql`
      select 1 from runs where org_id = ${orgId} and state in ('approved', 'applying')
      union all
      select 1 from step_attempts where org_id = ${orgId} and state in ('dispatched', 'unknown_outcome')
      limit 1
    `);
    if (rows.length > 0) throw new OrgWorldBusy();
    await reset(orgId);
  });
}

const WORLDS = [
  { vendor: "stripe", world: "planning" },
  { vendor: "zendesk", world: "planning" },
  { vendor: "stripe", world: "operational" },
  { vendor: "zendesk", world: "operational" },
] as const;

const AUTH = { stripe: "Bearer sk_test_rehearsal_seed", zendesk: "Bearer rehearsal-seed" } as const;

/** Whether this world already holds the cohort: its first customer's charges, or its first ticket. */
async function hasCohort(vendor: "stripe" | "zendesk", world: WorldConfig): Promise<boolean> {
  const first = incidentRecords().cases[0];
  if (!first) throw new Error("the incident cohort is empty");
  const path =
    vendor === "stripe"
      ? `/v1/charges?customer=${encodeURIComponent(first.customerId)}&limit=1`
      : `/api/v2/tickets/${encodeURIComponent(first.ticketId)}.json`;
  const res = await eraFetch(world, path, { headers: { authorization: AUTH[vendor] } });
  if (vendor === "zendesk") {
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
    return true;
  }
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  const body = (await res.json()) as { data?: unknown[] };
  return (body.data?.length ?? 0) > 0;
}

/**
 * Seed one org's four worlds with the INC-BILL-0927 cohort (T1.2, the same seed `demo:reset`
 * plants), each world only if it doesn't hold the cohort yet. A world is reset before it is
 * seeded, so a half-seeded one is rebuilt whole; a seeded one is never reset unless `fresh` asks
 * for it. `fresh` also clears the org's Slack, back to Era's default channels.
 */
async function seedOrg(tenant: string, env: NodeJS.ProcessEnv, fresh = false): Promise<void> {
  const adminToken = env.ERA_ADMIN_TOKEN;
  if (!adminToken) throw new Error("ERA_ADMIN_TOKEN is not set");
  const bind = async (
    vendor: "stripe" | "zendesk" | "slack",
    world: "planning" | "operational",
  ) => {
    const config = resolveWorld(vendor, world, env, tenant);
    const { token } = await mintTenantToken(config, adminToken);
    return { ...config, tenantToken: token };
  };
  for (const { vendor, world } of WORLDS) {
    const bound = await bind(vendor, world);
    if (!fresh && (await hasCohort(vendor, bound))) continue;
    await adminOrThrow(bound, "/reset");
    await seedIncident(vendor, bound);
  }
  // Slack only where summaries are posted, as the company overview reads it.
  if (fresh && env.RUN_SUMMARY_CHANNEL && env.ERA_SLACK_OPERATIONAL_URL) {
    await adminOrThrow(await bind("slack", "operational"), "/reset");
  }
}

const seeded = new Set<string>();
const inFlight = new Map<string, Promise<void>>();

/**
 * Make sure the org's tenants exist and hold the demo cohort. Idempotent: once an org is seeded
 * it is never touched again by this process, and racing callers share one seeding. A failure
 * isn't remembered, so the next call tries again.
 */
export function ensureOrgSeeded(
  orgId: string,
  opts: { env?: NodeJS.ProcessEnv; seed?: (tenant: string) => Promise<void> } = {},
): Promise<void> {
  const tenant = orgTenant(orgId);
  const running = inFlight.get(tenant);
  if (running) return running;
  if (seeded.has(tenant)) return Promise.resolve();
  const seed = opts.seed ?? ((t: string) => seedOrg(t, opts.env ?? process.env));
  const next = seed(tenant)
    .then(() => {
      seeded.add(tenant);
    })
    .finally(() => {
      inFlight.delete(tenant);
    });
  inFlight.set(tenant, next);
  return next;
}

/**
 * "Reset my world" (#331): put the org's worlds back to the seeded cohort, dropping every problem
 * created and every write applied there. Only Era state goes: plans, approvals, runs and receipts
 * stay, append-only. A seeding already running for the org finishes first.
 */
export async function resetOrgWorlds(
  orgId: string,
  opts: { env?: NodeJS.ProcessEnv; reset?: (tenant: string) => Promise<void> } = {},
): Promise<void> {
  const tenant = orgTenant(orgId);
  await inFlight.get(tenant)?.catch(() => undefined);
  seeded.delete(tenant);
  const reset = opts.reset ?? ((t: string) => seedOrg(t, opts.env ?? process.env, true));
  const next = reset(tenant).then(() => {
    seeded.add(tenant);
  });
  inFlight.set(tenant, next);
  try {
    await next;
  } finally {
    if (inFlight.get(tenant) === next) inFlight.delete(tenant);
  }
}
