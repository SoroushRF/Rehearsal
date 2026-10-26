import {
  type CompanyCharge,
  type CompanyCustomer,
  type CompanySlackMessage,
  type CompanyTicket,
  Currency,
  type EntityRef,
  type Observation,
  type QueryObservation,
  type QueryPredicate,
  type World,
} from "@rehearsal/contracts";
import { type Clock, fingerprint, type ProviderPort, type WorldContext } from "@rehearsal/core";
import { z } from "zod";
import { eraFetch, NO_REDIRECTS } from "./era";
import type { WorldConfig } from "./worlds";

/** The read half of a ProviderPort. T3 owns the write half (see write.ts). */
export type ProviderReader = Pick<ProviderPort, "vendor" | "observe" | "query">;

/** One world a reader is bound to. Chosen by the server, never a URL from a plan or the model. */
export interface ReadTarget {
  /** `rehearsal` only for an execution rehearsal's own disposable tenant (T3.16). */
  world: World | "rehearsal";
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
      ? await (target.fetch ?? fetch)(`${target.config.baseUrl}${path}`, {
          ...init,
          ...NO_REDIRECTS,
        })
      : await eraFetch(target.config, path, init);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * A rehearsal's tenant stands where the operational world would: its reads are what the step
 * guard compares with the plan's evidence, and are never stored or shown as operational data.
 */
const observedWorld = (target: ReadTarget): World =>
  target.world === "rehearsal" ? "operational" : target.world;

function observation(
  target: ReadTarget,
  entity: EntityRef,
  projectionVersion: string,
  projection: Record<string, unknown>,
): Observation {
  return {
    id: `obs_${entity.kind}_${entity.id}`,
    world: observedWorld(target),
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
    world: observedWorld(target),
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

// --- Company overview (live demo, #330) -----------------------------------------------------------
//
// Read-only lists of one world's records for `GET /api/company`, projected to the contract's row
// shapes. Each list stops at `limit` rows (at most 200) or at the first page that is missing,
// malformed or repeated; a short list is a partial view, never a claim that nothing else exists.

/** The most rows any company list returns. */
export const COMPANY_LIST_CAP = 200;

const cap = (limit: number) => Math.max(0, Math.min(COMPANY_LIST_CAP, Math.floor(limit)));
const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

const ListedCharge = z.object({
  id: z.string().min(1),
  customer: z.string().min(1),
  amount: z.int().nonnegative(),
  amount_refunded: z.int().nonnegative(),
  currency: z.string().regex(/^[a-z]{3}$/),
  invoice: z.string().nullable().optional(),
  created: z.int().nonnegative(),
});
const ListedCustomer = z.object({
  id: z.string().min(1),
  email: z.string().nullable().optional(),
  balance: z.int().optional(),
});
const StripeList = <T extends z.ZodType>(row: T) =>
  z.object({ data: z.array(row), has_more: z.boolean() });

/** Pages scanned at most for one list, whatever `keep` filters out. */
const COMPANY_MAX_PAGES = 20;

/**
 * Pages a Stripe list endpoint with `starting_after` until `limit` kept rows, the end, or
 * {@link COMPANY_MAX_PAGES} pages.
 */
async function stripeList<T extends { id: string }>(
  target: ReadTarget,
  path: string,
  row: z.ZodType<T>,
  limit: number,
  keep: (r: T) => boolean = () => true,
): Promise<T[]> {
  const out: T[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  for (let page = 0; out.length < limit && page < COMPANY_MAX_PAGES; page++) {
    const params = new URLSearchParams({ limit: "100" });
    if (after) params.set("starting_after", after);
    const parsed = StripeList(row).safeParse(await getJson(target, `${path}?${params}`));
    if (!parsed.success) break;
    const { data, has_more } = parsed.data;
    if (data.some((r) => seen.has(r.id))) break;
    for (const r of data) {
      seen.add(r.id);
      if (keep(r)) out.push(r);
    }
    const last = data.at(-1)?.id;
    if (!has_more || !last || last === after) break;
    after = last;
  }
  return out.slice(0, limit);
}

/** The world's charges, newest first as Stripe lists them. */
export async function listCharges(
  target: ReadTarget,
  limit = COMPANY_LIST_CAP,
): Promise<CompanyCharge[]> {
  // The contract's currency list is CAD only (#329). A charge in another currency is left out of
  // the overview rather than failing the whole snapshot; the plan's own evidence still has it.
  // The shared world is mostly other currencies, so the scan keeps going past them.
  const rows = await stripeList(
    target,
    "/v1/charges",
    ListedCharge,
    cap(limit),
    (c) => Currency.safeParse(c.currency).success,
  );
  return rows.flatMap((c) => {
    const currency = Currency.safeParse(c.currency);
    if (!currency.success) return [];
    return [
      {
        id: c.id,
        customer: c.customer,
        invoice: c.invoice ?? null,
        amountMinor: c.amount,
        currency: currency.data,
        created: iso(c.created),
        refundedMinor: c.amount_refunded,
      },
    ];
  });
}

/** The world's customers, with their balance in minor units (negative is credit owed). */
export async function listCustomers(
  target: ReadTarget,
  limit = COMPANY_LIST_CAP,
): Promise<CompanyCustomer[]> {
  const rows = await stripeList(target, "/v1/customers", ListedCustomer, cap(limit));
  return rows.map((c) => ({ id: c.id, email: c.email ?? null, balanceMinor: c.balance ?? 0 }));
}

const ListedTicket = z.object({
  id: TicketId,
  subject: z.string().nullable().optional(),
  status: z.string(),
  priority: z.string().nullable(),
  requester_id: TicketId.nullable(),
  updated_at: z.string(),
});
const ListedTicketPage = z.object({
  tickets: z.array(ListedTicket),
  next_page: z.string().min(1).nullable(),
});

/** The world's tickets, following `next_page` on the same origin only. */
export async function listTickets(
  target: ReadTarget,
  limit = COMPANY_LIST_CAP,
): Promise<CompanyTicket[]> {
  const max = cap(limit);
  const origin = new URL(target.config.baseUrl).origin;
  const out: CompanyTicket[] = [];
  const seen = new Set<string>();
  const ids = new Set<number>();
  let path: string | null = `/api/v2/tickets.json?per_page=${Math.min(100, max) || 1}`;
  while (path && out.length < max && !seen.has(path)) {
    seen.add(path);
    const parsed = ListedTicketPage.safeParse(await getJson(target, path));
    if (!parsed.success) break;
    for (const t of parsed.data.tickets) {
      const id = Number(t.id);
      if (!Number.isSafeInteger(id) || id <= 0) continue;
      if (ids.has(id)) return out;
      ids.add(id);
      const updated = Date.parse(t.updated_at);
      out.push({
        id,
        subject: t.subject ?? "",
        status: t.status,
        priority: t.priority,
        requester: t.requester_id === null ? "" : String(t.requester_id),
        updatedAt: Number.isFinite(updated) ? new Date(updated).toISOString() : iso(0),
      });
    }
    const next = parsed.data.next_page;
    if (!next) break;
    const url = new URL(next, origin);
    if (url.origin !== origin) break;
    path = `${url.pathname}${url.search}`;
  }
  return out.slice(0, max);
}

const SlackHistoryPage = z.object({
  ok: z.boolean(),
  messages: z.array(z.object({ ts: z.string().min(1), text: z.string().optional() })).optional(),
  has_more: z.boolean().optional(),
  response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
});

/** One channel's messages, newest first, from `conversations.history`. */
export async function listSlackMessages(
  target: ReadTarget,
  channel: string,
  limit = COMPANY_LIST_CAP,
): Promise<CompanySlackMessage[]> {
  const max = cap(limit);
  const out: CompanySlackMessage[] = [];
  const cursors = new Set<string>();
  let cursor = "";
  while (out.length < max) {
    const params = new URLSearchParams({ channel, limit: String(Math.min(200, max - out.length)) });
    if (cursor) params.set("cursor", cursor);
    const parsed = SlackHistoryPage.safeParse(
      await getJson(target, `/api/conversations.history?${params}`),
    );
    if (!parsed.success || !parsed.data.ok) break;
    for (const m of parsed.data.messages ?? []) out.push({ ts: m.ts, channel, text: m.text ?? "" });
    const next = parsed.data.response_metadata?.next_cursor ?? "";
    if (!parsed.data.has_more || !next || cursors.has(next)) break;
    cursors.add(next);
    cursor = next;
  }
  return out.slice(0, max);
}
