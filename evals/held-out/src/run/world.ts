import type { ProviderPort } from "@rehearsal/core";
import {
  eraAdmin,
  slackProviderWriter,
  stripeReader,
  stripeWriter,
  withWriter,
  writeOnly,
  zendeskReader,
  zendeskWriter,
} from "@rehearsal/providers";
import type { SeededCase } from "@rehearsal/testkit";
import {
  adminToken,
  getComments,
  getJson,
  getTicket,
  resetTenant,
  scratchWorld,
  stripePost,
  uniqueTenant,
  zendeskPutTicket,
} from "../../../providers/src/harness";
import type { CaseOutcome } from "../../../scorecard/src/score";
import type { Priority } from "../../../scorecard/src/tasks";
import { type CaseReads, judgeCase, type KNOWN, type Worlds } from "../../../scorecard/src/world";
import type { Drift, Fault, Task } from "../schema";
import type { HeldOutSet } from "../sets";
import { seedSet } from "../world";

/**
 * T1.35: Era plumbing for running a held-out or catalog task, in the scorecard's shapes so its
 * agent, apply modes and summary reader work unchanged. Each world is a scratch tenant seeded with
 * the set's records and setup; drift and faults come from the task's data, not from the dev cohort.
 */

const AUTH = {
  stripe: "Bearer sk_test_rehearsal_held_out",
  zendesk: "Bearer rehearsal-held-out",
  slack: "Bearer xoxb-rehearsal-held-out",
};

/** Stripe and Zendesk seeded with the set and its setup; Slack, reset, when the set posts a summary. */
export async function setWorlds(
  set: HeldOutSet,
  world: "planning" | "operational",
  label: string,
): Promise<Worlds> {
  const tenant = uniqueTenant(label);
  const out = {} as Worlds;
  for (const vendor of ["stripe", "zendesk"] as const) {
    out[vendor] = await scratchWorld(vendor, world, tenant);
    await resetTenant(out[vendor]);
  }
  await seedSet(set, out);
  if (set.tasks.ops.summary) {
    out.slack = await scratchWorld("slack", world, tenant);
    await resetTenant(out.slack);
  }
  return out;
}

export function readers(worlds: Worlds, world: "planning" | "operational") {
  return {
    stripe: stripeReader({ world, config: worlds.stripe, authorization: AUTH.stripe }),
    zendesk: zendeskReader({ world, config: worlds.zendesk, authorization: AUTH.zendesk }),
  };
}

const caseOf = (set: HeldOutSet, key: string): SeededCase => {
  const c = set.records.cases.find((x) => x.key === key);
  if (!c) throw new Error(`${set.id} has no case ${key}`);
  return c;
};

/** Read-and-write ports on an operational world, with the task's faults in the transport. */
export function operationalPorts(
  set: HeldOutSet,
  worlds: Worlds,
  faults: readonly Fault[],
): { stripe: ProviderPort; zendesk: ProviderPort; slack?: ProviderPort } {
  const target = (vendor: "stripe" | "zendesk") => ({
    world: "operational" as const,
    config: worlds[vendor],
    authorization: AUTH[vendor],
  });
  return {
    stripe: withFaults(
      set,
      withWriter(stripeReader(target("stripe")), stripeWriter(target("stripe"))),
      faults,
    ),
    zendesk: withFaults(
      set,
      withWriter(zendeskReader(target("zendesk")), zendeskWriter(target("zendesk"))),
      faults,
    ),
    ...(worlds.slack && {
      slack: writeOnly(
        slackProviderWriter({
          world: "operational",
          config: worlds.slack,
          authorization: AUTH.slack,
        }),
      ),
    }),
  };
}

export const RETRY_AFTER_MS = 1000;

/**
 * The scorecard's transport faults, keyed to the set's cases, each firing once whichever mode
 * sends the write, plus `fail_charge_list_read`: every operational query of the case's charges
 * fails. Planning reads go through another port and are unaffected.
 */
function withFaults(set: HeldOutSet, port: ProviderPort, faults: readonly Fault[]): ProviderPort {
  if (faults.length === 0) return port;
  const fired = new Set<Fault>();
  const matches = (fault: Fault, path: string, body: string) => {
    if (fired.has(fault) || fault.kind === "fail_charge_list_read") return false;
    if (fault.kind === "throttle_first_refund") return path === "/v1/refunds";
    const c = caseOf(set, fault.caseKey);
    switch (fault.kind) {
      case "lose_refund_response":
        return (
          path === "/v1/refunds" &&
          c.chargeIds.slice(1).includes(new URLSearchParams(body).get("charge") ?? "")
        );
      case "lose_credit_response":
        return path === `/v1/customers/${c.customerId}/balance_transactions`;
      case "lose_note_response":
        return path === `/api/v2/tickets/${c.ticketId}.json` && body.includes('"public":false');
      case "lose_reply_response":
        return path === `/api/v2/tickets/${c.ticketId}.json` && body.includes('"public":true');
    }
  };
  const unreadable = new Set(
    faults.flatMap((f) =>
      f.kind === "fail_charge_list_read" ? [caseOf(set, f.caseKey).customerId] : [],
    ),
  );
  return {
    ...port,
    query: async (predicate, cutoff, ctx) => {
      if (
        predicate.kind === "stripe.charges.byCustomerInWindow" &&
        unreadable.has(predicate.customerId)
      ) {
        throw new Error(`charge list for ${predicate.customerId} unreadable (held-out fault)`);
      }
      return port.query(predicate, cutoff, ctx);
    },
    dispatch: async (req, ctx) => {
      const fault = faults.find((f) => matches(f, req.path, req.body));
      if (!fault) return port.dispatch(req, ctx);
      fired.add(fault);
      if (fault.kind === "throttle_first_refund") {
        return {
          kind: "rejected",
          status: 429,
          body: { error: { type: "rate_limit_error" } },
          retryable: true,
          retryAfterMs: RETRY_AFTER_MS,
        };
      }
      await port.dispatch(req, ctx);
      return {
        kind: "unknown",
        error: "response lost after Era applied the write (held-out fault)",
      };
    },
  };
}

/** A copy of the case's last charge with a new ID and date, for a customer (default: the case's). */
function chargeCopy(set: HeldOutSet, c: SeededCase, id: string, at: string, customer?: string) {
  const last = c.chargeIds.at(-1);
  const template = set.records.stripe.charges.find((ch) => ch.id === last);
  if (!template) throw new Error(`${set.id} has no charge ${last}`);
  return {
    ...template,
    id,
    ...(customer && { customer }),
    created: Date.parse(at) / 1000,
    payment_intent: `pi_${id.slice(3)}`,
    balance_transaction: `txn_${id.slice(3)}`,
    receipt_url: `https://pay.stripe.com/receipts/sim/${id}`,
    refunds: { object: "list", data: [], has_more: false, url: `/v1/charges/${id}/refunds` },
  };
}

async function ok(label: string, pending: Promise<Response>): Promise<void> {
  const res = await pending;
  if (!res.ok) throw new Error(`${label} → ${res.status} ${await res.text()}`);
}

/** What happens in the operational world between the plan and the writes. */
export async function applyDrift(set: HeldOutSet, worlds: Worlds, drift: readonly Drift[]) {
  const charges: Record<string, unknown>[] = [];
  for (const d of drift) {
    switch (d.kind) {
      case "phantom_charge":
      case "late_charge":
      case "early_charge":
        charges.push(chargeCopy(set, caseOf(set, d.caseKey), d.chargeId, d.at));
        break;
      case "stranger_charge": {
        const first = set.records.cases[0];
        if (!first) throw new Error(`${set.id} has no cases`);
        charges.push(chargeCopy(set, first, d.chargeId, d.at, d.customerId));
        break;
      }
      case "public_comment":
        await ok(
          d.kind,
          zendeskPutTicket(worlds.zendesk, caseOf(set, d.caseKey).ticketId, {
            comment: { body: "Any update on the refund?", public: true },
          }),
        );
        break;
      case "teammate_tag": {
        const id = caseOf(set, d.caseKey).ticketId;
        const ticket = await getTicket(worlds.zendesk, id);
        await ok(
          d.kind,
          zendeskPutTicket(worlds.zendesk, id, { tags: [...(ticket.tags as string[]), d.tag] }),
        );
        break;
      }
      case "teammate_priority":
        await ok(
          d.kind,
          zendeskPutTicket(worlds.zendesk, caseOf(set, d.caseKey).ticketId, {
            priority: d.priority,
          }),
        );
        break;
      case "teammate_refund_original": {
        const original = caseOf(set, d.caseKey).chargeIds[0];
        await ok(
          d.kind,
          stripePost(
            worlds.stripe,
            "/v1/refunds",
            new URLSearchParams({ charge: original }).toString(),
          ),
        );
        break;
      }
    }
  }
  if (charges.length > 0) {
    await ok("inject drift charges", eraAdmin(worlds.stripe, adminToken(), "/inject", { charges }));
  }
}

/** Every charge a case can hold after drift: its own and any the task injects for it. */
function chargesOf(c: SeededCase, task: Task): string[] {
  return [
    ...c.chargeIds,
    ...task.drift.flatMap((d) =>
      "caseKey" in d && "chargeId" in d && d.caseKey === c.key ? [d.chargeId] : [],
    ),
  ];
}

/** Charge ID → amount for the set and every charge its task injects, for `judgeCase`. */
function amountsOf(set: HeldOutSet, task: Task): Map<string, number> {
  const amounts = new Map(
    set.records.stripe.charges.map((ch) => [String(ch.id), Number(ch.amount)]),
  );
  for (const d of task.drift) {
    if (!("chargeId" in d)) continue;
    const c = "caseKey" in d ? caseOf(set, d.caseKey) : set.records.cases[0];
    if (c) amounts.set(d.chargeId, c.amountMinor);
  }
  return amounts;
}

/** Every case's end state, judged with the scorecard's exact-effect rules (T1.32). */
export async function readOutcomes(
  set: HeldOutSet,
  task: Task,
  worlds: Worlds,
): Promise<Record<string, CaseOutcome>> {
  const amounts = amountsOf(set, task);
  const out: Record<string, CaseOutcome> = {};
  for (const c of set.records.cases) {
    const refunds: CaseReads["refunds"] = [];
    for (const id of chargesOf(c, task)) {
      const list = await getJson<{
        data: { id: string; amount: number; currency: string; metadata?: unknown }[];
        has_more: boolean;
      }>("stripe", worlds.stripe, `/v1/refunds?charge=${id}&limit=100`);
      if (list.has_more) throw new Error(`more than 100 refunds on ${id}`);
      for (const r of list.data) {
        const ours =
          typeof (r.metadata as { rehearsal_op?: unknown } | null)?.rehearsal_op === "string";
        refunds.push({ id: r.id, charge: id, amount: r.amount, currency: r.currency, ours });
      }
    }
    const balance = await getJson<{
      data: { amount: number; currency: string }[];
      has_more: boolean;
    }>("stripe", worlds.stripe, `/v1/customers/${c.customerId}/balance_transactions?limit=100`);
    if (balance.has_more) throw new Error(`more than 100 balance transactions on ${c.customerId}`);
    const ticket = await getTicket(worlds.zendesk, c.ticketId);
    const comments = await getComments(worlds.zendesk, c.ticketId);
    out[c.key] = judgeCase(
      c,
      {
        refunds,
        credits: balance.data,
        priority: ticket.priority as Priority | null,
        comments: comments.map((x) => ({ public: x.public, body: x.body })),
      },
      amounts,
    );
  }
  return out;
}

/** What the answer key reads back, so `countOutside` counts our writes anywhere else. */
export function knownOf(set: HeldOutSet, task: Task): typeof KNOWN {
  return {
    charges: new Set(set.records.cases.flatMap((c) => chargesOf(c, task))),
    customers: new Set(set.records.cases.map((c) => c.customerId)),
    tickets: new Set(set.records.cases.map((c) => String(c.ticketId))),
  };
}
