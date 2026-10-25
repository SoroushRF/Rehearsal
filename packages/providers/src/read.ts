import type {
  EntityRef,
  Observation,
  QueryObservation,
  QueryPredicate,
  World,
} from "@rehearsal/contracts";
import { type Clock, fingerprint, type ProviderPort, type WorldContext } from "@rehearsal/core";
import { z } from "zod";
import { eraFetch } from "./era";
import type { WorldConfig } from "./worlds";

/** The read half of a ProviderPort. T3 owns the write half (see write.ts). */
export type ProviderReader = Pick<ProviderPort, "vendor" | "observe" | "query">;

/** One world a reader is bound to. Chosen by the server, never a URL from a plan or the model. */
export interface ReadTarget {
  world: World;
  config: WorldConfig;
  /** Value for the vendor's Authorization header. The simulators accept any bearer. */
  authorization: string;
  clock?: Clock;
  /** Records per page (Stripe allows 1–100). Tests lower it to exercise pagination. */
  pageSize?: number;
  /** Stop and report `complete: false` after this many pages. */
  maxPages?: number;
  /** Per-request timeout. Unset, a request waits as long as the world takes. */
  timeoutMs?: number;
  /**
   * `native` reads a real Stripe test-mode account (T1.24): plain HTTPS to `config.baseUrl`, with
   * no Era tenant header. Default `era`. Only operator conformance checks use it.
   */
  transport?: "era" | "native";
  /** Extra request headers, e.g. a pinned `Stripe-Version` for a native read. */
  headers?: Record<string, string>;
  /** The fetch a native read uses (tests stand in for Stripe). Defaults to the global one. */
  fetch?: typeof fetch;
}

export const STRIPE_CHARGE_PROJECTION = "stripe.charge.v2";
export const ZENDESK_TICKET_PROJECTION = "zendesk.ticket.v2";
/** A customer's billing currency, for a balance credit (T1.14). Null until Stripe sets one. */
export const STRIPE_CUSTOMER_PROJECTION = "stripe.customer.v1";

const ChargeRecord = z.object({
  id: z.string().min(1),
  customer: z.string().min(1),
  amount: z.int().nonnegative(),
  amount_refunded: z.int().nonnegative(),
  currency: z.string().regex(/^[a-z]{3}$/),
  status: z.enum(["succeeded", "pending", "failed"]),
  invoice: z.string().nullable(),
  created: z.int().nonnegative(),
});
const TicketId = z.union([z.int().positive(), z.string().regex(/^\d+$/)]);
const TicketRecord = z.object({
  id: TicketId,
  priority: z.enum(["low", "normal", "high", "urgent"]).nullable(),
  status: z.enum(["new", "open", "pending", "hold", "solved", "closed"]),
  requester_id: TicketId.nullable(),
  external_id: z.string().nullable(),
});
const CustomerRecord = z.object({
  id: z.string().min(1),
  currency: z
    .string()
    .regex(/^[a-z]{3}$/)
    .nullable()
    .optional(),
});
const ChargePage = z.object({ data: z.array(ChargeRecord), has_more: z.boolean() });
const BalanceCreditPage = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      amount: z.number(),
      currency: z.string(),
      type: z.string(),
      metadata: z.record(z.string(), z.string()).nullable().optional(),
    }),
  ),
  has_more: z.boolean(),
});
const TicketPage = z.object({
  tickets: z.array(TicketRecord),
  next_page: z.string().min(1).nullable(),
  count: z.int().nonnegative(),
});

/** The fields a plan depends on. Everything else (billing details, comment timestamps) is noise. */
export function stripeChargeProjection(c: Record<string, unknown>): Record<string, unknown> {
  return {
    id: c.id,
    customer: c.customer,
    amount: c.amount,
    amount_refunded: c.amount_refunded,
    currency: c.currency,
    status: c.status,
    invoice: c.invoice ?? null,
    created: c.created,
  };
}

/** IDs as strings, like EntityRef. Comments are left out: Zendesk rewrites their timestamps. */
export function zendeskTicketProjection(t: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(t.id),
    priority: t.priority,
    status: t.status,
    requester_id: t.requester_id == null ? null : String(t.requester_id),
    external_id: t.external_id ?? null,
  };
}

function assertTarget(target: ReadTarget, ctx: WorldContext) {
  if (ctx.world !== target.world || ctx.tenant !== target.config.tenant) {
    throw new Error(
      `reader is bound to ${target.world}/${target.config.tenant}, asked to read ${ctx.world}/${ctx.tenant}`,
    );
  }
}

async function getJson(target: ReadTarget, path: string): Promise<Record<string, unknown>> {
  const init: RequestInit = {
    headers: { ...target.headers, authorization: target.authorization },
    ...(target.timeoutMs !== undefined && { signal: AbortSignal.timeout(target.timeoutMs) }),
  };
  const res =
    target.transport === "native"
      ? await (target.fetch ?? fetch)(`${target.config.baseUrl}${path}`, init)
      : await eraFetch(target.config, path, init);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

function observation(
  target: ReadTarget,
  entity: EntityRef,
  projectionVersion: string,
  projection: Record<string, unknown>,
): Observation {
  return {
    id: `obs_${entity.kind}_${entity.id}`,
    world: target.world,
    entity,
    projectionVersion,
    projection,
    fingerprint: fingerprint(projection),
    capturedAt: (target.clock?.now() ?? new Date()).toISOString(),
  };
}

function queryObservation(
  target: ReadTarget,
  vendor: "stripe" | "zendesk",
  predicate: QueryPredicate,
  cutoff: string,
  complete: boolean,
  projectionVersion: string,
  records: Map<string, Record<string, unknown>>,
): QueryObservation {
  const matchingIds = [...records.keys()].sort();
  const projections = Object.fromEntries(matchingIds.map((id) => [id, records.get(id) ?? {}]));
  return {
    id: `q_${fingerprint(predicate).slice(0, 16)}`,
    world: target.world,
    vendor,
    predicate,
    cutoff,
    complete,
    matchingIds,
    projectionVersion,
    projections,
    fingerprint: fingerprint({ matchingIds, projections }),
    capturedAt: (target.clock?.now() ?? new Date()).toISOString(),
  };
}

const toUnix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/**
 * Stripe reads: one charge, one customer's currency, and every charge of a customer created in [createdGte, createdLt).
 * `complete` is true only if paging ended with `has_more: false`. A failed page, a cursor that
 * stops moving, or the page cap all leave it false: never proof of absence.
 */
export function stripeReader(target: ReadTarget): ProviderReader {
  return {
    vendor: "stripe",
    async observe(entity, ctx) {
      assertTarget(target, ctx);
      if (entity.vendor === "stripe" && entity.kind === "customer_balance_transactions") {
        const listed = await listBalanceCredits(target, entity.id);
        return observation(target, entity, "stripe.balance_credit.v1", listed);
      }
      if (entity.vendor === "stripe" && entity.kind === "customer") {
        const customer = CustomerRecord.parse(
          await getJson(target, `/v1/customers/${encodeURIComponent(entity.id)}`),
        );
        if (customer.id !== entity.id) {
          throw new Error(`asked for customer ${entity.id}, got ${customer.id}`);
        }
        // Only the currency: the balance moves with every credit, and a plan doesn't depend on it.
        return observation(target, entity, STRIPE_CUSTOMER_PROJECTION, {
          id: customer.id,
          currency: customer.currency ?? null,
        });
      }
      if (entity.vendor !== "stripe" || entity.kind !== "charge") {
        throw new Error(`stripe can't observe ${entity.vendor}.${entity.kind}`);
      }
      const charge = ChargeRecord.parse(
        await getJson(target, `/v1/charges/${encodeURIComponent(entity.id)}`),
      );
      if (charge.id !== entity.id)
        throw new Error(`asked for charge ${entity.id}, got ${charge.id}`);
      return observation(target, entity, STRIPE_CHARGE_PROJECTION, stripeChargeProjection(charge));
    },
    async query(predicate, cutoff, ctx) {
      assertTarget(target, ctx);
      if (predicate.kind !== "stripe.charges.byCustomerInWindow") {
        throw new Error(`stripe can't query ${predicate.kind}`);
      }
      const gte = toUnix(predicate.createdGte);
      const lt = toUnix(predicate.createdLt);
      const base = new URLSearchParams({
        customer: predicate.customerId,
        "created[gte]": String(gte),
        "created[lt]": String(lt),
        limit: String(target.pageSize ?? 100),
      });
      const records = new Map<string, Record<string, unknown>>();
      let complete = false;
      let after: string | undefined;
      const seenIds = new Set<string>();
      for (let page = 0; page < (target.maxPages ?? 50); page++) {
        const params = new URLSearchParams(base);
        if (after) params.set("starting_after", after);
        let body: Record<string, unknown>;
        try {
          body = await getJson(target, `/v1/charges?${params}`);
        } catch {
          break;
        }
        const parsed = ChargePage.safeParse(body);
        if (!parsed.success) break;
        const { data, has_more } = parsed.data;
        if (
          data.some((c) => seenIds.has(c.id)) ||
          new Set(data.map((c) => c.id)).size !== data.length
        )
          break;
        for (const c of data) {
          seenIds.add(c.id);
          // Keep only true matches, whatever the server returned.
          const created = Number(c.created);
          if (c.customer === predicate.customerId && created >= gte && created < lt) {
            records.set(String(c.id), stripeChargeProjection(c));
          }
        }
        if (!has_more) {
          complete = true;
          break;
        }
        const last = data.at(-1)?.id;
        if (typeof last !== "string" || last === after) break;
        after = last;
      }
      return queryObservation(
        target,
        "stripe",
        predicate,
        cutoff,
        complete,
        STRIPE_CHARGE_PROJECTION,
        records,
      );
    },
  };
}

/**
 * Every negative adjustment on the customer's balance: an invoice credit. `complete` is false when
 * a page is missing, repeated, or the page cap is hit. That is not proof that no credit exists.
 * A credit names its charge only through `metadata.charge` or `metadata.charge_id`.
 */
async function listBalanceCredits(
  target: ReadTarget,
  customerId: string,
): Promise<Record<string, unknown>> {
  const credits: {
    id: string;
    amountMinor: number;
    currency: string;
    chargeId: string | null;
  }[] = [];
  let after: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < (target.maxPages ?? 50); page++) {
    const params = new URLSearchParams({ limit: String(target.pageSize ?? 100) });
    if (after) params.set("starting_after", after);
    let body: Record<string, unknown>;
    try {
      body = await getJson(
        target,
        `/v1/customers/${encodeURIComponent(customerId)}/balance_transactions?${params}`,
      );
    } catch {
      return { complete: false, credits };
    }
    const parsed = BalanceCreditPage.safeParse(body);
    if (!parsed.success) return { complete: false, credits };
    const { data, has_more } = parsed.data;
    if (
      data.some((item) => seen.has(item.id)) ||
      new Set(data.map((item) => item.id)).size !== data.length
    ) {
      return { complete: false, credits };
    }
    for (const item of data) {
      seen.add(item.id);
      // A manual adjustment or a credit note applied to the balance: either credits the customer.
      if (item.type !== "adjustment" && item.type !== "credit_note") continue;
      // A float, a blank id, or a currency we cannot match is not proof that no credit exists.
      const currency = item.currency.toLowerCase();
      if (item.id.length === 0 || !Number.isInteger(item.amount) || !/^[a-z]{3}$/.test(currency)) {
        return { complete: false, credits };
      }
      if (item.amount >= 0) continue;
      const named = item.metadata?.charge ?? item.metadata?.charge_id ?? "";
      credits.push({
        id: item.id,
        amountMinor: -item.amount,
        currency,
        chargeId: named.length > 0 ? named : null,
      });
    }
    if (!has_more) return { complete: true, credits };
    const last = data.at(-1)?.id;
    if (!last || last === after) return { complete: false, credits };
    after = last;
  }
  return { complete: false, credits };
}

/**
 * Zendesk reads: one ticket, and every ticket a user requested. Pages follow `next_page` only on
 * the bound world's own origin. `complete` also requires the record total to match `count`.
 */
export function zendeskReader(target: ReadTarget): ProviderReader {
  return {
    vendor: "zendesk",
    async observe(entity, ctx) {
      assertTarget(target, ctx);
      if (entity.vendor !== "zendesk" || entity.kind !== "ticket" || !/^\d+$/.test(entity.id)) {
        throw new Error(`zendesk can't observe ${entity.vendor}.${entity.kind} ${entity.id}`);
      }
      const body = await getJson(target, `/api/v2/tickets/${entity.id}.json`);
      const ticket = TicketRecord.parse(body.ticket);
      if (String(ticket.id) !== entity.id) {
        throw new Error(`asked for ticket ${entity.id}, got ${ticket.id}`);
      }
      return observation(
        target,
        entity,
        ZENDESK_TICKET_PROJECTION,
        zendeskTicketProjection(ticket),
      );
    },
    async query(predicate, cutoff, ctx) {
      assertTarget(target, ctx);
      if (
        predicate.kind !== "zendesk.tickets.byRequester" ||
        !/^\d+$/.test(predicate.requesterId)
      ) {
        throw new Error(`zendesk can't query ${predicate.kind}`);
      }
      const origin = new URL(target.config.baseUrl).origin;
      const records = new Map<string, Record<string, unknown>>();
      let complete = false;
      let path: string | undefined =
        `/api/v2/users/${predicate.requesterId}/tickets/requested.json?per_page=${target.pageSize ?? 100}`;
      const seen = new Set<string>();
      const seenIds = new Set<string>();
      let expectedCount: number | undefined;
      for (let page = 0; path && page < (target.maxPages ?? 50); page++) {
        seen.add(path);
        let body: Record<string, unknown>;
        try {
          body = await getJson(target, path);
        } catch {
          break;
        }
        const parsed = TicketPage.safeParse(body);
        if (!parsed.success) break;
        const { tickets, count, next_page: next } = parsed.data;
        expectedCount ??= count;
        if (
          count !== expectedCount ||
          tickets.some((t) => seenIds.has(String(t.id))) ||
          new Set(tickets.map((t) => String(t.id))).size !== tickets.length
        )
          break;
        for (const t of tickets) {
          seenIds.add(String(t.id));
          if (String(t.requester_id) === predicate.requesterId) {
            records.set(String(t.id), zendeskTicketProjection(t));
          }
        }
        if (next === null) {
          complete = count === records.size;
          break;
        }
        if (typeof next !== "string") break;
        let url: URL;
        try {
          url = new URL(next, origin);
        } catch {
          break;
        }
        if (url.origin !== origin) break;
        path = `${url.pathname}${url.search}`;
        if (seen.has(path)) break;
      }
      return queryObservation(
        target,
        "zendesk",
        predicate,
        cutoff,
        complete,
        ZENDESK_TICKET_PROJECTION,
        records,
      );
    },
  };
}
