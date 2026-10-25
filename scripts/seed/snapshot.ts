import {
  ExecutionRehearsalId,
  type ExecutionRehearsalState,
  type PlanManifest,
  TERMINAL_REHEARSAL_STATES,
} from "@rehearsal/contracts";
import { canonicalize, rehearsalTenant } from "@rehearsal/core";
import {
  eraAdmin,
  eraFetch,
  mintTenantToken,
  STRIPE_CHARGE_PROJECTION,
  stripeChargeProjection,
  type WorldConfig,
  ZENDESK_TICKET_PROJECTION,
  zendeskTicketProjection,
} from "@rehearsal/providers";
import { fixtureTemplates } from "@rehearsal/testkit";
import { z } from "zod";

/**
 * T1.22 (decision 0013, §4): seed an execution rehearsal's disposable tenant from the plan's own
 * evidence, read it back before anything runs, and tear it down afterwards. Operator code: it holds
 * the rehearsal admin token and runs only in the rehearsal containers (`pnpm infra:up:rehearsal`).
 *
 * Fidelity limits, also listed in the report as "not from evidence":
 * - Fields outside a projection come from the verbatim templates in scenarios/billing/fixtures
 *   (billing details, payment method, ticket subject and thread, …).
 * - A prior refund is seeded as `amount_refunded` only; its refund objects aren't in evidence.
 * - A ticket gets one public comment. Its real thread isn't in evidence (Zendesk rewrites comment
 *   timestamps, so the projection leaves them out).
 * - Every tenant starts from Era's seeded baseline. Records the plan never read come from it, and
 *   the read-back fails if one of them lands in a query the plan cites.
 */

export type SnapshotVendor = "stripe" | "zendesk";
const VENDORS: SnapshotVendor[] = ["stripe", "zendesk"];

type Evidence = Pick<PlanManifest, "actions" | "observations" | "queryObservations">;

/** The projections the seeder can rebuild a record from, by entity. */
const SUPPORTED: Record<string, string> = {
  "stripe.charge": STRIPE_CHARGE_PROJECTION,
  "zendesk.ticket": ZENDESK_TICKET_PROJECTION,
};
const QUERY_PROJECTION: Record<string, string> = {
  stripe: STRIPE_CHARGE_PROJECTION,
  zendesk: ZENDESK_TICKET_PROJECTION,
};

const ChargeProjection = z.strictObject({
  id: z.string().regex(/^ch_\w+$/),
  customer: z.string().min(1),
  amount: z.int().nonnegative(),
  amount_refunded: z.int().nonnegative(),
  currency: z.string().regex(/^[a-z]{3}$/),
  status: z.enum(["succeeded", "pending", "failed"]),
  invoice: z.string().nullable(),
  created: z.int().nonnegative(),
});
const TicketProjection = z.strictObject({
  id: z.string().regex(/^\d+$/),
  priority: z.enum(["low", "normal", "high", "urgent"]).nullable(),
  status: z.enum(["new", "open", "pending", "hold", "solved", "closed"]),
  requester_id: z.string().regex(/^\d+$/).nullable(),
  external_id: z.string().nullable(),
});
type ChargeProjection = z.infer<typeof ChargeProjection>;
type TicketProjection = z.infer<typeof TicketProjection>;

/** Template fields the seeder sets from the projection, so they aren't fixture defaults. */
const DERIVED = {
  stripe: [
    "object",
    "amount_captured",
    "refunded",
    "captured",
    "paid",
    "description",
    "payment_intent",
    "balance_transaction",
    "receipt_url",
    "metadata",
    "refunds",
  ],
  zendesk: ["url", "subject", "raw_subject", "description", "submitter_id"],
};

export interface SnapshotSeed {
  /** Bodies for POST /_admin/tenants/{T}/inject. */
  stripe: { charges: Record<string, unknown>[] };
  zendesk: { tickets: Record<string, unknown>[] };
  /** Seeded fields that didn't come from the plan's evidence, as `vendor.kind.field`. */
  notFromEvidence: string[];
}

export type SnapshotSupport = { ok: true; seed: SnapshotSeed } | { ok: false; refusals: string[] };

/** The entity a step writes, or null for a kind the seeder can't rebuild. */
function writeTarget(action: Evidence["actions"][number]) {
  switch (action.kind) {
    case "stripe.refund.create":
      return { vendor: "stripe", kind: "charge", id: action.args.chargeId };
    case "zendesk.ticket.patchFields":
    case "zendesk.ticket.appendPrivateNote":
      return { vendor: "zendesk", kind: "ticket", id: action.args.ticketId };
    default:
      return null;
  }
}

/**
 * Whether a plan's evidence is enough to rebuild what it read, and the inject bodies if it is.
 * Pure: a refused snapshot never reaches a world, so nothing is ever partially seeded.
 */
export function supportSnapshot(plan: Evidence): SnapshotSupport {
  const refusals: string[] = [];
  const observations = new Map(plan.observations.map((o) => [o.id, o]));
  const queries = new Set(plan.queryObservations.map((q) => q.id));

  for (const action of plan.actions) {
    for (const id of action.evidence) {
      if (!observations.has(id)) refusals.push(`${action.id} cites ${id}, which the plan lacks`);
    }
    for (const id of action.queryEvidence) {
      if (!queries.has(id)) refusals.push(`${action.id} cites ${id}, which the plan lacks`);
    }
    const target = writeTarget(action);
    if (!target) {
      refusals.push(`${action.id}: the seeder can't rebuild what ${action.kind} writes`);
      continue;
    }
    const observed = action.evidence.some((id) => {
      const e = observations.get(id)?.entity;
      return e?.vendor === target.vendor && e.kind === target.kind && e.id === target.id;
    });
    if (!observed) {
      refusals.push(`${action.id} writes ${target.vendor} ${target.kind} ${target.id} unobserved`);
    }
  }

  const charges = new Map<string, { projection: ChargeProjection; source: string }>();
  const tickets = new Map<string, { projection: TicketProjection; source: string }>();
  const record = (vendor: string, source: string, projection: unknown) => {
    const parsed =
      vendor === "stripe"
        ? ChargeProjection.safeParse(projection)
        : TicketProjection.safeParse(projection);
    if (!parsed.success) {
      refusals.push(`${source}: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
      return;
    }
    const map = (vendor === "stripe" ? charges : tickets) as Map<
      string,
      { projection: unknown; source: string }
    >;
    const seen = map.get(parsed.data.id);
    if (!seen) map.set(parsed.data.id, { projection: parsed.data, source });
    else if (canonicalize(seen.projection) !== canonicalize(parsed.data)) {
      refusals.push(`${seen.source} and ${source} disagree about ${parsed.data.id}`);
    }
  };

  for (const o of plan.observations) {
    const key = `${o.entity.vendor}.${o.entity.kind}`;
    if (o.world !== "planning") {
      refusals.push(`${o.id} was read in the ${o.world} world, not the planning world`);
    } else if (!SUPPORTED[key]) {
      refusals.push(`${o.id}: the seeder can't rebuild a ${o.entity.vendor} ${o.entity.kind}`);
    } else if (o.projectionVersion !== SUPPORTED[key]) {
      refusals.push(
        `${o.id}: ${o.projectionVersion} leaves out fields the simulator needs (${SUPPORTED[key]} has them)`,
      );
    } else if (o.projection.id !== o.entity.id) {
      refusals.push(`${o.id} observes ${o.entity.id} but projects ${String(o.projection.id)}`);
    } else {
      record(o.entity.vendor, o.id, o.projection);
    }
  }
  for (const q of plan.queryObservations) {
    if (q.world !== "planning") {
      refusals.push(`${q.id} was read in the ${q.world} world, not the planning world`);
    } else if (!q.complete) {
      refusals.push(`${q.id} is incomplete: a partial enumeration can't be rebuilt`);
    } else if (q.projectionVersion !== QUERY_PROJECTION[q.vendor]) {
      refusals.push(`${q.id}: the seeder can't rebuild ${q.projectionVersion} records`);
    } else {
      for (const id of q.matchingIds) {
        if (!q.projections[id]) refusals.push(`${q.id} matches ${id} but has no projection of it`);
        else record(q.vendor, `${q.id}[${id}]`, q.projections[id]);
      }
    }
  }
  if (refusals.length > 0) return { ok: false, refusals };

  const templates = fixtureTemplates();
  const defaults = (vendor: SnapshotVendor, kind: string, template: object, used: boolean) => {
    const shape = vendor === "stripe" ? ChargeProjection.shape : TicketProjection.shape;
    return used
      ? Object.keys(template)
          .filter((f) => !(f in shape) && !DERIVED[vendor].includes(f))
          .map((f) => `${vendor}.${kind}.${f}`)
      : [];
  };
  return {
    ok: true,
    seed: {
      stripe: { charges: [...charges.values()].map((c) => charge(templates.charge, c.projection)) },
      zendesk: {
        tickets: [...tickets.values()].map((t) => ticket(templates.ticket, t.projection)),
      },
      notFromEvidence: [
        ...defaults("stripe", "charge", templates.charge, charges.size > 0),
        ...defaults("zendesk", "ticket", templates.ticket, tickets.size > 0),
      ].sort(),
    },
  };
}

function charge(template: Record<string, unknown>, p: ChargeProjection): Record<string, unknown> {
  const suffix = p.id.slice(3);
  const succeeded = p.status === "succeeded";
  return {
    ...template,
    ...p,
    object: "charge",
    amount_captured: succeeded ? p.amount : 0,
    refunded: p.amount_refunded > 0 && p.amount_refunded >= p.amount,
    captured: succeeded,
    paid: succeeded,
    description: p.invoice ? `Invoice ${p.invoice}` : null,
    payment_intent: `pi_${suffix}`,
    balance_transaction: `txn_${suffix}`,
    receipt_url: `https://pay.stripe.com/receipts/sim/${p.id}`,
    metadata: {},
    refunds: { object: "list", data: [], has_more: false, url: `/v1/charges/${p.id}/refunds` },
  };
}

function ticket(template: Record<string, unknown>, p: TicketProjection): Record<string, unknown> {
  const subject = `Rehearsal copy of ticket ${p.id}`;
  const body = "Seeded for an execution rehearsal. The real thread is not in the plan's evidence.";
  const requester = p.requester_id === null ? null : Number(p.requester_id);
  return {
    ...template,
    ...p,
    id: Number(p.id),
    url: `https://northwind.zendesk.com/api/v2/tickets/${p.id}.json`,
    subject,
    raw_subject: subject,
    description: body,
    requester_id: requester,
    submitter_id: requester,
    comments: [{ body, public: true }],
  };
}

// --- Worlds ----------------------------------------------------------------

const REHEARSAL_URL_KEYS: Record<SnapshotVendor, string> = {
  stripe: "ERA_STRIPE_REHEARSAL_URL",
  zendesk: "ERA_ZENDESK_REHEARSAL_URL",
};
const SHARED_URL_KEYS = [
  "ERA_STRIPE_PLANNING_URL",
  "ERA_STRIPE_OPERATIONAL_URL",
  "ERA_ZENDESK_PLANNING_URL",
  "ERA_ZENDESK_OPERATIONAL_URL",
  "ERA_SLACK_PLANNING_URL",
  "ERA_SLACK_OPERATIONAL_URL",
];

/** Host and port, with loopback spellings folded together. */
function endpoint(url: string): string {
  const u = new URL(url);
  const host = ["localhost", "[::1]"].includes(u.hostname) ? "127.0.0.1" : u.hostname;
  return `${host}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
}

export function rehearsalAdminToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env.REHEARSAL_ERA_ADMIN_TOKEN;
  if (!token) throw new Error("REHEARSAL_ERA_ADMIN_TOKEN is not set (copy .env.example to .env)");
  if (token === env.ERA_ADMIN_TOKEN) {
    throw new Error("REHEARSAL_ERA_ADMIN_TOKEN must differ from ERA_ADMIN_TOKEN");
  }
  return token;
}

/**
 * A rehearsal's tenant in the rehearsal container for one vendor. The tenant is derived from the
 * ID, and a URL that a planning or operational world also uses is refused.
 */
export function rehearsalWorldConfig(
  vendor: SnapshotVendor,
  rehearsalId: string,
  env: NodeJS.ProcessEnv = process.env,
): WorldConfig {
  const id = ExecutionRehearsalId.parse(rehearsalId);
  const key = REHEARSAL_URL_KEYS[vendor];
  const raw = env[key];
  if (!raw) throw new Error(`${key} is not set (pnpm infra:up:rehearsal)`);
  const baseUrl = raw.replace(/\/$/, "");
  for (const shared of SHARED_URL_KEYS) {
    const other = env[shared];
    if (other && endpoint(other) === endpoint(baseUrl)) {
      throw new Error(`${key} is ${shared}'s world: a rehearsal never runs in a shared world`);
    }
  }
  return { baseUrl, tenant: rehearsalTenant(id) };
}

export type RehearsalWorlds = Partial<Record<SnapshotVendor, WorldConfig>>;

async function admin(world: WorldConfig, path: string, body?: unknown, env = process.env) {
  const res = await eraAdmin(world, rehearsalAdminToken(env), path, body);
  if (!res.ok) throw new Error(`${world.tenant} ${path} → ${res.status} ${await res.text()}`);
}

export type Provisioned =
  | { ok: true; worlds: RehearsalWorlds; notFromEvidence: string[] }
  | { ok: false; refusals: string[] };

/** Check the snapshot, then reset the rehearsal's tenants and inject it. */
export async function provisionSnapshot(
  plan: Evidence,
  rehearsalId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Provisioned> {
  const support = supportSnapshot(plan);
  if (!support.ok) return support;
  const { seed } = support;
  const bodies = {
    stripe: { records: seed.stripe.charges.length, body: seed.stripe },
    zendesk: { records: seed.zendesk.tickets.length, body: seed.zendesk },
  };
  const worlds: RehearsalWorlds = {};
  for (const vendor of VENDORS) {
    const { records, body } = bodies[vendor];
    if (records === 0) continue;
    const config = rehearsalWorldConfig(vendor, rehearsalId, env);
    const { token } = await mintTenantToken(config, rehearsalAdminToken(env));
    const world = { ...config, tenantToken: token };
    await admin(world, "/reset", undefined, env);
    await admin(world, "/inject", body, env);
    worlds[vendor] = world;
  }
  return { ok: true, worlds, notFromEvidence: seed.notFromEvidence };
}

// --- Read-back -------------------------------------------------------------

const AUTH: Record<SnapshotVendor, string> = {
  stripe: "Bearer sk_test_rehearsal_snapshot",
  zendesk: "Bearer rehearsal-snapshot",
};

async function read(vendor: SnapshotVendor, world: WorldConfig, path: string) {
  const res = await eraFetch(world, path, { headers: { authorization: AUTH[vendor] } });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

// Raw list pages, checked before anything is compared: a short or repeated page must not read as
// "the same population" just because every row it did return matches.
const Row = z.record(z.string(), z.unknown());
const StripeChargePage = z.object({ data: z.array(Row), has_more: z.boolean() });
const ZendeskTicketPage = z.object({
  tickets: z.array(Row),
  count: z.number().int().nonnegative(),
  next_page: z.string().nullable(),
});

function uniqueIds(rows: Record<string, unknown>[]): string[] {
  const ids = rows.map((r) => String(r.id));
  const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))].sort();
  if (dupes.length > 0) throw new Error(`page repeats ${dupes.join(", ")}`);
  return ids;
}

function differing(want: Record<string, unknown>, got: Record<string, unknown>): string[] {
  const fields = new Set([...Object.keys(want), ...Object.keys(got)]);
  return [...fields].filter((f) => canonicalize(want[f]) !== canonicalize(got[f])).sort();
}

/**
 * Read the seeded tenant back and compare it with the exact evidence the plan cites: every
 * observation's projection, and every query's membership and projections. Raw reads with the
 * projection functions, not the executor's readers, so a reader bug can't hide a bad seed. Any
 * mismatch refuses the run.
 */
export async function verifySnapshot(
  plan: Evidence,
  worlds: RehearsalWorlds,
): Promise<{ ok: boolean; mismatches: string[] }> {
  const mismatches: string[] = [];
  const compare = (source: string, want: Record<string, unknown>, got: Record<string, unknown>) => {
    const fields = differing(want, got);
    if (fields.length > 0) mismatches.push(`${source}: ${fields.join(", ")} differ`);
  };

  for (const o of plan.observations) {
    const vendor = o.entity.vendor as SnapshotVendor;
    const world = worlds[vendor];
    if (!world) {
      mismatches.push(`${o.id}: no rehearsal world for ${o.entity.vendor}`);
      continue;
    }
    try {
      const id = encodeURIComponent(o.entity.id);
      const got =
        vendor === "stripe"
          ? stripeChargeProjection(await read(vendor, world, `/v1/charges/${id}`))
          : zendeskTicketProjection(
              (await read(vendor, world, `/api/v2/tickets/${id}.json`)).ticket as Record<
                string,
                unknown
              >,
            );
      compare(o.id, o.projection, got);
    } catch (err) {
      mismatches.push(`${o.id}: ${(err as Error).message}`);
    }
  }

  for (const q of plan.queryObservations) {
    const world = worlds[q.vendor as SnapshotVendor];
    if (!world) {
      mismatches.push(`${q.id}: no rehearsal world for ${q.vendor}`);
      continue;
    }
    try {
      const got = new Map<string, Record<string, unknown>>();
      const p = q.predicate;
      if (p.kind === "stripe.charges.byCustomerInWindow") {
        const gte = Math.floor(Date.parse(p.createdGte) / 1000);
        const lt = Math.floor(Date.parse(p.createdLt) / 1000);
        const params = new URLSearchParams({
          customer: p.customerId,
          "created[gte]": String(gte),
          "created[lt]": String(lt),
          limit: "100",
        });
        const page = StripeChargePage.parse(await read("stripe", world, `/v1/charges?${params}`));
        if (page.has_more) throw new Error("more than 100 matches; can't enumerate");
        uniqueIds(page.data);
        for (const c of page.data) {
          const created = Number(c.created);
          if (c.customer === p.customerId && created >= gte && created < lt) {
            got.set(String(c.id), stripeChargeProjection(c));
          }
        }
      } else {
        const path = `/api/v2/users/${encodeURIComponent(p.requesterId)}/tickets/requested.json?per_page=100`;
        const page = ZendeskTicketPage.parse(await read("zendesk", world, path));
        if (page.next_page !== null) throw new Error("more than 100 matches; can't enumerate");
        const returned = uniqueIds(page.tickets).length;
        if (page.count !== returned) {
          throw new Error(`count is ${page.count} but the page has ${returned} tickets`);
        }
        for (const t of page.tickets) {
          if (String(t.requester_id) === p.requesterId) {
            got.set(String(t.id), zendeskTicketProjection(t));
          }
        }
      }
      const extra = [...got.keys()].filter((id) => !q.matchingIds.includes(id)).sort();
      const missing = q.matchingIds.filter((id) => !got.has(id));
      if (extra.length > 0) mismatches.push(`${q.id}: ${extra.join(", ")} match, not in evidence`);
      if (missing.length > 0) mismatches.push(`${q.id}: ${missing.join(", ")} no longer match`);
      for (const id of q.matchingIds) {
        const want = q.projections[id];
        const have = got.get(id);
        if (want && have) compare(`${q.id}[${id}]`, want, have);
      }
    } catch (err) {
      mismatches.push(`${q.id}: ${(err as Error).message}`);
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

// --- Teardown --------------------------------------------------------------

/**
 * Reset a finished rehearsal's tenants. Only `rh-` tenants in the rehearsal containers, only once
 * the rehearsal is terminal (so the verifier has read it), and idempotent. Returns what it reset.
 */
export async function teardownSnapshot(
  rehearsalId: string,
  state: ExecutionRehearsalState,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  if (!(TERMINAL_REHEARSAL_STATES as readonly string[]).includes(state)) {
    throw new Error(`rehearsal ${rehearsalId} is ${state}: only a finished one is torn down`);
  }
  const reset: string[] = [];
  for (const vendor of VENDORS) {
    if (!env[REHEARSAL_URL_KEYS[vendor]]) continue;
    const world = rehearsalWorldConfig(vendor, rehearsalId, env);
    await admin(world, "/reset", undefined, env);
    reset.push(`${vendor}/${world.tenant}`);
  }
  return reset;
}
