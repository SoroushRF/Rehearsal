import { eraAdmin, type WorldConfig } from "@rehearsal/providers";
import { adminToken, type EraVendor, getJson, stripePost } from "../../providers/src/harness";
import type { HeldOutSet } from "./sets";

/**
 * Era plumbing for a held-out set: seed a world with the set's records and customers, then plant
 * its setup (a refund or a credit someone made before the incident) through the ordinary API.
 * Apply both to the planning and the operational world; they must then read back the same.
 */

export type Worlds = Record<EraVendor, WorldConfig>;

async function ok(label: string, pending: Promise<Response>): Promise<void> {
  const res = await pending;
  if (!res.ok) throw new Error(`${label} → ${res.status} ${await res.text()}`);
}

export async function seedSet(set: HeldOutSet, worlds: Worlds): Promise<void> {
  await ok("inject charges", eraAdmin(worlds.stripe, adminToken(), "/inject", set.records.stripe));
  await ok(
    "inject customers",
    eraAdmin(worlds.stripe, adminToken(), "/inject", { customers: set.customers }),
  );
  await ok(
    "inject tickets",
    eraAdmin(worlds.zendesk, adminToken(), "/inject", set.records.zendesk),
  );
  for (const step of set.tasks.setup) {
    const c = set.records.cases.find((x) => x.key === step.caseKey);
    const chargeId = c?.chargeIds[step.charge];
    if (!c || !chargeId) throw new Error(`${set.id}: setup names a missing charge`);
    // A fixed key per set and step, so re-running setup can't plant it twice.
    const key = `held-out-${set.id}-${step.kind}-${chargeId}`;
    if (step.kind === "refund_charge") {
      await ok(key, stripePost(worlds.stripe, "/v1/refunds", `charge=${chargeId}`, key));
    } else {
      const body = `amount=-${c.amountMinor}&currency=${c.currency}&metadata[charge]=${chargeId}`;
      await ok(
        key,
        stripePost(worlds.stripe, `/v1/customers/${c.customerId}/balance_transactions`, body, key),
      );
    }
  }
}

/**
 * What a planner can see of the set in one world: each customer's charges (with what was refunded)
 * and balance credits, and each ticket. Era-generated IDs and timestamps are dropped, so two worlds
 * seeded the same way compare equal.
 */
export async function snapshotSet(set: HeldOutSet, worlds: Worlds): Promise<unknown> {
  const out: Record<string, unknown> = {};
  for (const c of set.records.cases) {
    const charges = await getJson<{ data: Record<string, unknown>[]; has_more: boolean }>(
      "stripe",
      worlds.stripe,
      `/v1/charges?customer=${c.customerId}&limit=100`,
    );
    const balance = await getJson<{ data: Record<string, unknown>[]; has_more: boolean }>(
      "stripe",
      worlds.stripe,
      `/v1/customers/${c.customerId}/balance_transactions?limit=100`,
    );
    if (charges.has_more || balance.has_more) throw new Error(`${c.customerId}: too many records`);
    const ticket = await getJson<{ ticket: Record<string, unknown> }>(
      "zendesk",
      worlds.zendesk,
      `/api/v2/tickets/${c.ticketId}.json`,
    );
    out[c.key] = {
      charges: charges.data
        .map((ch) => ({
          id: ch.id,
          amount: ch.amount,
          amount_refunded: ch.amount_refunded,
          currency: ch.currency,
          created: ch.created,
          invoice: ch.invoice,
          status: ch.status,
        }))
        .sort((a, b) => String(a.id).localeCompare(String(b.id))),
      credits: balance.data.map((t) => ({
        amount: t.amount,
        currency: t.currency,
        metadata: t.metadata,
      })),
      ticket: {
        id: ticket.ticket.id,
        external_id: ticket.ticket.external_id,
        requester_id: ticket.ticket.requester_id,
        priority: ticket.ticket.priority,
        status: ticket.ticket.status,
        tags: ticket.ticket.tags,
      },
    };
  }
  return out;
}
