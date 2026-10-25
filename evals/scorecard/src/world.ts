import { OPERATION_MARKER_PREFIX } from "@rehearsal/contracts";
import { type ProviderPort, renderReply } from "@rehearsal/core";
import {
  eraAdmin,
  slackProviderWriter,
  stripeReader,
  stripeWriter,
  type WorldConfig,
  withWriter,
  writeOnly,
  zendeskReader,
  zendeskWriter,
} from "@rehearsal/providers";
import { INCIDENT, incidentRecords, type SeededCase } from "@rehearsal/testkit";
import { seedIncident } from "../../../scripts/seed/incident";
import {
  adminToken,
  type EraVendor,
  getComments,
  getJson,
  getTicket,
  resetTenant,
  scratchWorld,
  stripePost,
  uniqueTenant,
  zendeskPutTicket,
} from "../../providers/src/harness";
import { SUMMARY_CHANNEL } from "./agent";
import type { CaseOutcome, SummaryOutcome } from "./score";
import type { CaseKey, Drift, Fault, Priority } from "./tasks";

/**
 * Era plumbing for the scorecard: fresh seeded tenants, the drift each task applies to an
 * operational world, transport faults on the write path, and the end state read back for scoring.
 * Every world is a throwaway tenant bound by a signed token; `resetScratchTenants` clears them.
 */

export const records = incidentRecords();
export const CASES: ReadonlyMap<CaseKey, SeededCase> = new Map(
  records.cases.map((c) => [c.key, c]),
);

export function cohortCase(key: CaseKey): SeededCase {
  const c = CASES.get(key);
  if (!c) throw new Error(`cohort has no case ${key}`);
  return c;
}

/** Slack only for a task with a run summary (it needs `pnpm infra:up:full`). */
export type Worlds = Record<EraVendor, WorldConfig> & { slack?: WorldConfig };

/**
 * The cohort's Stripe customers, billed in the case's currency. Era serves an unknown customer
 * as 404, and a balance credit checks the customer's currency first (T1.14).
 */
const customers = records.cases.map((c) => ({
  id: c.customerId,
  object: "customer",
  currency: c.currency,
  balance: 0,
  email: c.email,
  name: c.name,
  metadata: {},
  livemode: false,
  created: Date.parse(INCIDENT.window.createdGte) / 1000 - 86_400 * 30,
}));

/** Both vendors' worlds for one tenant, reset and seeded with the incident; Slack if asked. */
export async function seededWorlds(
  world: "planning" | "operational",
  label: string,
  opts: { slack?: boolean } = {},
): Promise<Worlds> {
  const tenant = uniqueTenant(label);
  const out = {} as Worlds;
  for (const vendor of ["stripe", "zendesk"] as const) {
    out[vendor] = await scratchWorld(vendor, world, tenant);
    await resetTenant(out[vendor]);
    await seedIncident(vendor, out[vendor]);
  }
  await ok(eraAdmin(out.stripe, adminToken(), "/inject", { customers }));
  if (opts.slack) {
    out.slack = await scratchWorld("slack", world, tenant);
    await resetTenant(out.slack);
  }
  return out;
}

const AUTH = {
  stripe: "Bearer sk_test_rehearsal_scorecard",
  zendesk: "Bearer rehearsal-scorecard",
  slack: "Bearer xoxb-rehearsal-scorecard",
};

export function readers(worlds: Worlds, world: "planning" | "operational") {
  return {
    stripe: stripeReader({ world, config: worlds.stripe, authorization: AUTH.stripe }),
    zendesk: zendeskReader({ world, config: worlds.zendesk, authorization: AUTH.zendesk }),
  };
}

/** Read-and-write ports on an operational world, with the task's transport faults applied. */
export function operationalPorts(
  worlds: Worlds,
  faults: readonly Fault[],
): { stripe: ProviderPort; zendesk: ProviderPort; slack?: ProviderPort } {
  const target = (vendor: EraVendor) => ({
    world: "operational" as const,
    config: worlds[vendor],
    authorization: AUTH[vendor],
  });
  return {
    stripe: withFaults(
      withWriter(stripeReader(target("stripe")), stripeWriter(target("stripe"))),
      faults,
    ),
    zendesk: withFaults(
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
 * Faults happen in the transport, so they hit exactly one write whichever mode sends it:
 * - throttle: the first refund send is answered 429 with Retry-After and never reaches Era;
 * - lose: the write reaches Era and applies, and its response is replaced by a transport error.
 */
function withFaults(port: ProviderPort, faults: readonly Fault[]): ProviderPort {
  if (faults.length === 0) return port;
  const fired = new Set<Fault>();
  const matches = (fault: Fault, path: string, body: string) => {
    if (fired.has(fault)) return false;
    if (fault.kind === "throttle_first_refund") return path === "/v1/refunds";
    const c = cohortCase(fault.caseKey);
    switch (fault.kind) {
      case "lose_refund_response":
        return path === "/v1/refunds" && new URLSearchParams(body).get("charge") === c.chargeIds[1];
      case "lose_credit_response":
        return path === `/v1/customers/${c.customerId}/balance_transactions`;
      case "lose_note_response":
        return path === `/api/v2/tickets/${c.ticketId}.json` && body.includes('"public":false');
      case "lose_reply_response":
        return path === `/api/v2/tickets/${c.ticketId}.json` && body.includes('"public":true');
    }
  };
  return {
    ...port,
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
        error: "response lost after Era applied the write (scorecard fault)",
      };
    },
  };
}

const phantomId = (key: CaseKey) => `ch_INC0927${key}phantom`;
const LATE_ID = (key: CaseKey) => `ch_INC0927${key}late`;
const STRANGER_ID = "ch_INC0927stranger";

/** A copy of the case's second charge with a new ID and date (the scripts/inject/phantom shape). */
function chargeCopy(key: CaseKey, id: string, createdIso: string, customer?: string) {
  const c = cohortCase(key);
  const template = records.stripe.charges.find((ch) => ch.id === c.chargeIds[1]);
  if (!template) throw new Error(`cohort has no charge ${c.chargeIds[1]}`);
  return {
    ...template,
    id,
    ...(customer && { customer }),
    created: Date.parse(createdIso) / 1000,
    payment_intent: `pi_${id.slice(3)}`,
    balance_transaction: `txn_${id.slice(3)}`,
    receipt_url: `https://pay.stripe.com/receipts/sim/${id}`,
    refunds: { object: "list", data: [], has_more: false, url: `/v1/charges/${id}/refunds` },
  };
}

/** What happens in the operational world between the plan and the writes. */
export async function applyDrift(worlds: Worlds, drift: readonly Drift[]): Promise<void> {
  const charges: Record<string, unknown>[] = [];
  for (const d of drift) {
    switch (d.kind) {
      case "phantom_charge":
        charges.push(chargeCopy(d.caseKey, phantomId(d.caseKey), "2026-09-25T09:00:00.000Z"));
        break;
      case "late_charge":
        charges.push(chargeCopy(d.caseKey, LATE_ID(d.caseKey), "2026-10-10T09:00:00.000Z"));
        break;
      case "stranger_charge":
        charges.push(
          chargeCopy("c01", STRANGER_ID, "2026-09-25T09:00:00.000Z", "cus_scorecardStranger"),
        );
        break;
      case "public_comment":
        await ok(
          zendeskPutTicket(worlds.zendesk, cohortCase(d.caseKey).ticketId, {
            comment: { body: "Any update on the refund?", public: true },
          }),
        );
        break;
      case "teammate_priority":
        await ok(
          zendeskPutTicket(worlds.zendesk, cohortCase(d.caseKey).ticketId, {
            priority: d.priority,
          }),
        );
        break;
      case "teammate_refund_original": {
        const original = cohortCase(d.caseKey).chargeIds[0];
        await ok(
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
    await ok(eraAdmin(worlds.stripe, adminToken(), "/inject", { charges }));
  }
}

async function ok(pending: Promise<Response>): Promise<void> {
  const res = await pending;
  if (!res.ok) throw new Error(`drift → ${res.status} ${await res.text()}`);
}

const MARKER = new RegExp(`\\n\\n${escapeRegExp(OPERATION_MARKER_PREFIX)}[^\\]]+\\]$`);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every cohort case's end state: refunds on its charges (injected ones too), credits on its
 * balance, priority, new notes, and our public replies (those carrying an operation marker).
 * A refund or credit for another amount, or a reply that isn't the approved text, is incorrect.
 */
export async function readOutcomes(worlds: Worlds): Promise<Record<CaseKey, CaseOutcome>> {
  const amounts = new Map(records.stripe.charges.map((ch) => [String(ch.id), Number(ch.amount)]));
  const out: Record<CaseKey, CaseOutcome> = {};
  for (const c of records.cases) {
    let refunds = 0;
    let incorrect = 0;
    const duplicateAmount = amounts.get(c.chargeIds[1] ?? "");
    for (const id of [...c.chargeIds, phantomId(c.key), LATE_ID(c.key)]) {
      const list = await getJson<{ data: { amount: number }[]; has_more: boolean }>(
        "stripe",
        worlds.stripe,
        `/v1/refunds?charge=${id}&limit=100`,
      );
      if (list.has_more) throw new Error(`more than 100 refunds on ${id}`);
      refunds += list.data.length;
      const charged = amounts.get(id) ?? duplicateAmount;
      incorrect += list.data.filter((r) => r.amount !== charged).length;
    }
    const balance = await getJson<{
      data: { amount: number; currency: string }[];
      has_more: boolean;
    }>("stripe", worlds.stripe, `/v1/customers/${c.customerId}/balance_transactions?limit=100`);
    if (balance.has_more) throw new Error(`more than 100 balance transactions on ${c.customerId}`);
    const credits = balance.data.filter((t) => t.amount < 0);
    incorrect += credits.filter(
      (t) => t.amount !== -(duplicateAmount ?? 0) || t.currency !== c.currency,
    ).length;

    const ticket = await getTicket(worlds.zendesk, c.ticketId);
    const comments = await getComments(worlds.zendesk, c.ticketId);
    const ours = comments.filter((x) => x.public && MARKER.test(x.body));
    const reply = `${renderReply(
      { id: "refund-issued", version: 1 },
      { customerName: c.name, amountMinor: duplicateAmount ?? 1 },
    )}`;
    incorrect += ours.filter((x) => x.body.replace(MARKER, "") !== reply).length;
    out[c.key] = {
      refunds,
      credits: credits.length,
      priority: ticket.priority as Priority | null,
      notes: comments.filter((x) => !x.public).length,
      replies: ours.length,
      incorrect,
    };
  }
  return out;
}

/** The run-summary posts in the channel (bot posts carrying a marker), with the refunds each claims. */
export async function readSummary(worlds: Worlds): Promise<SummaryOutcome> {
  if (!worlds.slack) return { posts: 0, claimedRefunds: [] };
  // Era seeds #general with more than a page of messages, so follow the cursor to the end.
  const messages: { text?: string; bot_id?: string }[] = [];
  let cursor = "";
  for (let page = 0; ; page++) {
    if (page >= 20) throw new Error("Slack history too long to read");
    const history = await getJson<{
      ok: boolean;
      messages: { text?: string; bot_id?: string }[];
      has_more?: boolean;
      response_metadata?: { next_cursor?: string };
    }>(
      "slack",
      worlds.slack,
      `/api/conversations.history?channel=${SUMMARY_CHANNEL}&limit=200${cursor && `&cursor=${encodeURIComponent(cursor)}`}`,
    );
    if (!history.ok) throw new Error("unreadable Slack history");
    messages.push(...history.messages);
    cursor = history.response_metadata?.next_cursor ?? "";
    if (!history.has_more || !cursor) break;
  }
  const posts = messages.filter(
    (m) => m.bot_id !== undefined && m.text?.includes(OPERATION_MARKER_PREFIX),
  );
  return {
    posts: posts.length,
    claimedRefunds: posts.map((m) =>
      Number(/(\d+) refund\(s\) issued/.exec(m.text ?? "")?.[1] ?? NaN),
    ),
  };
}

/** Counts requests to Era while `fn` runs. Planning and apply phases never overlap. */
export async function countingEraCalls<T>(
  worlds: readonly Worlds[],
  fn: () => Promise<T>,
): Promise<{ value: T; calls: number }> {
  const bases = new Set(
    worlds.flatMap((w) => [
      w.stripe.baseUrl,
      w.zendesk.baseUrl,
      ...(w.slack ? [w.slack.baseUrl] : []),
    ]),
  );
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if ([...bases].some((b) => url.startsWith(b))) calls++;
    return original(input, init);
  };
  try {
    return { value: await fn(), calls };
  } finally {
    globalThis.fetch = original;
  }
}
