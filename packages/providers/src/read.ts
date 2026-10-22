import type {
  EntityRef,
  Observation,
  QueryObservation,
  QueryPredicate,
  World,
} from "@rehearsal/contracts";
import { type Clock, fingerprint, type ProviderPort, type WorldContext } from "@rehearsal/core";
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
}

export const STRIPE_CHARGE_PROJECTION = "stripe.charge.v1";
export const ZENDESK_TICKET_PROJECTION = "zendesk.ticket.v1";

/** The fields a plan depends on. Everything else (billing details, comment timestamps) is noise. */
export function stripeChargeProjection(c: Record<string, unknown>): Record<string, unknown> {
  return {
    id: c.id,
    customer: c.customer,
    amount: c.amount,
    amount_refunded: c.amount_refunded,
    currency: c.currency,
    status: c.status,
  };
}

/** IDs as strings, like EntityRef. Comments are left out: Zendesk rewrites their timestamps. */
export function zendeskTicketProjection(t: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(t.id),
    priority: t.priority,
    status: t.status,
    requester_id: t.requester_id == null ? null : String(t.requester_id),
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
  const res = await eraFetch(target.config, path, {
    headers: { authorization: target.authorization },
  });
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
 * Stripe reads: one charge, and every charge of a customer created in [createdGte, createdLt).
 * `complete` is true only if paging ended with `has_more: false`. A failed page, a cursor that
 * stops moving, or the page cap all leave it false: never proof of absence.
 */
export function stripeReader(target: ReadTarget): ProviderReader {
  return {
    vendor: "stripe",
    async observe(entity, ctx) {
      assertTarget(target, ctx);
      if (entity.vendor !== "stripe" || entity.kind !== "charge") {
        throw new Error(`stripe can't observe ${entity.vendor}.${entity.kind}`);
      }
      const charge = await getJson(target, `/v1/charges/${encodeURIComponent(entity.id)}`);
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
      for (let page = 0; page < (target.maxPages ?? 50); page++) {
        const params = new URLSearchParams(base);
        if (after) params.set("starting_after", after);
        let body: Record<string, unknown>;
        try {
          body = await getJson(target, `/v1/charges?${params}`);
        } catch {
          break;
        }
        const data = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : null;
        if (!data) break;
        for (const c of data) {
          // Keep only true matches, whatever the server returned.
          const created = Number(c.created);
          if (c.customer === predicate.customerId && created >= gte && created < lt) {
            records.set(String(c.id), stripeChargeProjection(c));
          }
        }
        if (body.has_more === false) {
          complete = true;
          break;
        }
        const last = data.at(-1)?.id;
        if (body.has_more !== true || typeof last !== "string" || last === after) break;
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
      const ticket = body.ticket as Record<string, unknown> | undefined;
      if (!ticket || String(ticket.id) !== entity.id) {
        throw new Error(`asked for ticket ${entity.id}, got ${ticket?.id}`);
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
      for (let page = 0; path && page < (target.maxPages ?? 50); page++) {
        seen.add(path);
        let body: Record<string, unknown>;
        try {
          body = await getJson(target, path);
        } catch {
          break;
        }
        const tickets = Array.isArray(body.tickets)
          ? (body.tickets as Record<string, unknown>[])
          : null;
        if (!tickets) break;
        for (const t of tickets) {
          if (String(t.requester_id) === predicate.requesterId) {
            records.set(String(t.id), zendeskTicketProjection(t));
          }
        }
        const next = body.next_page;
        if (next === null || next === undefined) {
          complete = body.count === undefined || body.count === records.size;
          break;
        }
        if (typeof next !== "string") break;
        const url = new URL(next, origin);
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
