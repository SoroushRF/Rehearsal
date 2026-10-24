import type Anthropic from "@anthropic-ai/sdk";
import type { Observation, QueryPredicate } from "@rehearsal/contracts";
import { fingerprint } from "@rehearsal/core";
import type { MessagesClient, PlanningReader } from "@rehearsal/planner";
import {
  STRIPE_CHARGE_PROJECTION,
  stripeChargeProjection,
  ZENDESK_TICKET_PROJECTION,
  zendeskTicketProjection,
} from "@rehearsal/providers";
import { incidentRecords } from "@rehearsal/testkit";

/** In-memory planning world over the seeded cohort, with the real read projections. */
export function planningWorld() {
  const records = incidentRecords();
  const charges = new Map(records.stripe.charges.map((c) => [String(c.id), c]));
  const tickets = new Map(records.zendesk.tickets.map((t) => [String(t.id), t]));
  const at = "2026-10-02T12:00:00.000Z";
  const observation = (
    entity: Observation["entity"],
    projectionVersion: string,
    projection: Record<string, unknown>,
  ): Observation => ({
    id: `obs_${entity.kind}_${entity.id}`,
    world: "planning",
    entity,
    projectionVersion,
    projection,
    fingerprint: fingerprint(projection),
    capturedAt: at,
  });
  const queryResult = (
    vendor: "stripe" | "zendesk",
    predicate: QueryPredicate,
    cutoff: string,
    projectionVersion: string,
    hits: Record<string, unknown>[],
    project: (r: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    const matchingIds = hits.map((r) => String(r.id)).sort();
    const projections = Object.fromEntries(hits.map((r) => [String(r.id), project(r)]));
    return {
      id: `q_${fingerprint(predicate).slice(0, 16)}`,
      world: "planning" as const,
      vendor,
      predicate,
      cutoff,
      complete: true,
      matchingIds,
      projectionVersion,
      projections,
      fingerprint: fingerprint({ matchingIds, projections }),
      capturedAt: at,
    };
  };
  const stripe: PlanningReader = {
    vendor: "stripe",
    async observe(entity) {
      const c = charges.get(entity.id);
      if (!c) throw new Error(`GET /v1/charges/${entity.id} → 404`);
      return observation(entity, STRIPE_CHARGE_PROJECTION, stripeChargeProjection(c));
    },
    async query(predicate, cutoff) {
      if (predicate.kind !== "stripe.charges.byCustomerInWindow") throw new Error("unsupported");
      const gte = Date.parse(predicate.createdGte) / 1000;
      const lt = Date.parse(predicate.createdLt) / 1000;
      const hits = [...charges.values()].filter(
        (c) =>
          c.customer === predicate.customerId && Number(c.created) >= gte && Number(c.created) < lt,
      );
      return queryResult(
        "stripe",
        predicate,
        cutoff,
        STRIPE_CHARGE_PROJECTION,
        hits,
        stripeChargeProjection,
      );
    },
  };
  const zendesk: PlanningReader = {
    vendor: "zendesk",
    async observe(entity) {
      const t = tickets.get(entity.id);
      if (!t) throw new Error(`GET /api/v2/tickets/${entity.id}.json → 404`);
      return observation(entity, ZENDESK_TICKET_PROJECTION, zendeskTicketProjection(t));
    },
    async query(predicate, cutoff) {
      if (predicate.kind !== "zendesk.tickets.byRequester") throw new Error("unsupported");
      const hits = [...tickets.values()].filter(
        (t) => String(t.requester_id) === predicate.requesterId,
      );
      return queryResult(
        "zendesk",
        predicate,
        cutoff,
        ZENDESK_TICKET_PROJECTION,
        hits,
        zendeskTicketProjection,
      );
    },
  };
  return { readers: { stripe, zendesk }, records };
}

export type Call = [name: string, input: Record<string, unknown>];

/** A model reply: a turn of tool calls, or a finished turn when there are none. */
export function reply(
  model: string,
  calls: Call[],
  extra: Partial<Pick<Anthropic.Message, "stop_reason" | "stop_details">> = {},
): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model,
    content: [
      ...(calls.length === 0 ? [{ type: "text", text: "Done.", citations: null }] : []),
      ...calls.map(([name, input], i) => ({ type: "tool_use", id: `tu_${i}`, name, input })),
    ],
    stop_reason: extra.stop_reason ?? (calls.length > 0 ? "tool_use" : "end_turn"),
    stop_sequence: null,
    stop_details: extra.stop_details ?? null,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 80 },
  } as unknown as Anthropic.Message;
}

/** Replays a fixed script and records every request it was sent. Never calls a real model. */
export function scriptedModel(turns: Array<Anthropic.Message | Error>) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: MessagesClient = {
    async create(params) {
      requests.push(structuredClone(params));
      const next = turns[requests.length - 1];
      if (!next) throw new Error(`script has no turn ${requests.length}`);
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { client, requests };
}
