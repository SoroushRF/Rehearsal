import type { PlanManifest, RehearsalScenarioRef, Vendor } from "@rehearsal/contracts";
import {
  type CreditView,
  type ReadResult,
  type RefundView,
  resolveScenario,
  type VerifierReads,
} from "@rehearsal/core";
import { z } from "zod";
import { eraFetch } from "./era";
import { resolveRehearsalWorld, type WorldConfig, worldUrl } from "./worlds";

/**
 * T4.12: read a rehearsal tenant for the verifier. The worlds are the ones the operator bound
 * for this rehearsal. A URL that is not that rehearsal container, or a page that fails, comes
 * back as a failed read. An empty list is returned only when the provider said the list ended.
 */

const MAX_PAGES = 50;

const RefundPage = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      status: z.string().min(1),
      amount: z.number(),
      currency: z.string(),
      charge: z.string().min(1),
      metadata: z.record(z.string(), z.string()).optional(),
    }),
  ),
  has_more: z.boolean(),
  livemode: z.boolean().optional(),
});

const CreditPage = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      amount: z.number(),
      currency: z.string(),
      type: z.string(),
      metadata: z.record(z.string(), z.string()).nullable().optional(),
    }),
  ),
  has_more: z.boolean(),
  livemode: z.boolean().optional(),
});

const ChargePage = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      customer: z.string().min(1),
      created: z.number(),
    }),
  ),
  has_more: z.boolean(),
  livemode: z.boolean().optional(),
});

const TicketBody = z.object({
  ticket: z.object({
    priority: z.string().nullable(),
    status: z.string().min(1),
  }),
});

const CommentPage = z.object({
  comments: z.array(z.object({ body: z.string(), public: z.boolean() })),
  next_page: z.string().min(1).nullable(),
});

const SlackHistory = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  has_more: z.boolean().optional(),
  messages: z.array(z.object({ text: z.string().optional() })).optional(),
  response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
});

export async function readVerifierEffects(input: {
  manifest: PlanManifest;
  rehearsalId: string;
  scenario: RehearsalScenarioRef;
  worlds: Partial<Record<Vendor, WorldConfig>>;
  env?: NodeJS.ProcessEnv;
}): Promise<VerifierReads> {
  const env = input.env ?? process.env;
  const reads: VerifierReads = {
    refunds: {},
    queries: {},
    tickets: {},
    comments: {},
    credits: {},
    slack: {},
  };
  const stripe = openWorld("stripe", input.rehearsalId, input.worlds.stripe, env);
  const zendesk = openWorld("zendesk", input.rehearsalId, input.worlds.zendesk, env);
  const needsSlack = input.manifest.actions.some(
    (action) => action.kind === "slack.message.postSummary",
  );
  const slack = needsSlack
    ? openWorld("slack", input.rehearsalId, input.worlds.slack, env)
    : undefined;

  for (const action of input.manifest.actions) {
    if (action.kind === "stripe.refund.create") {
      reads.refunds[action.args.chargeId] ??= await readOrFail(stripe, (world) =>
        listRefunds(world, action.args.chargeId),
      );
    } else if (action.kind === "stripe.customer.balanceCredit") {
      reads.credits[action.args.customerId] ??= await readOrFail(stripe, (world) =>
        listCredits(world, action.args.customerId),
      );
    } else if (action.kind === "zendesk.ticket.patchFields") {
      reads.tickets[action.args.ticketId] ??= await readOrFail(zendesk, (world) =>
        readTicket(world, action.args.ticketId),
      );
    } else if (
      action.kind === "zendesk.ticket.appendPrivateNote" ||
      action.kind === "zendesk.ticket.appendPublicReply"
    ) {
      reads.comments[action.args.ticketId] ??= await readOrFail(zendesk, (world) =>
        listComments(world, action.args.ticketId),
      );
    } else if (action.kind === "slack.message.postSummary") {
      reads.slack[action.args.channelId] ??= await readOrFail(slack, (world) =>
        listSlack(world, action.args.channelId),
      );
    }
  }

  const bound = resolveScenario(input.manifest, input.scenario);
  if (bound.ok) {
    for (const effect of bound.scenario.effects) {
      if (effect.kind !== "query_membership" || reads.queries[effect.queryId]) continue;
      const query = input.manifest.queryObservations.find((item) => item.id === effect.queryId);
      reads.queries[effect.queryId] = await readOrFail(stripe, async (world) => {
        if (query?.predicate.kind !== "stripe.charges.byCustomerInWindow") {
          return { ok: false, detail: `query ${effect.queryId} cannot be re-run` };
        }
        return listCharges(world, query.predicate);
      });
    }
  }
  return reads;
}

/** A bound world that is this rehearsal's container, or why it is not safe to read. */
function openWorld(
  vendor: Vendor,
  rehearsalId: string,
  given: WorldConfig | undefined,
  env: NodeJS.ProcessEnv,
): WorldConfig | string {
  let expected: WorldConfig;
  try {
    expected = resolveRehearsalWorld(vendor, rehearsalId, env);
  } catch (err) {
    return (err as Error).message;
  }
  if (!given) return `no ${vendor} rehearsal world was bound`;
  try {
    if (
      worldUrl(given.baseUrl) !== worldUrl(expected.baseUrl) ||
      given.tenant !== expected.tenant
    ) {
      return `${vendor} reads are bound to ${expected.tenant} at the rehearsal world`;
    }
  } catch (err) {
    return (err as Error).message;
  }
  return given;
}

async function readOrFail<T>(
  world: WorldConfig | string | undefined,
  read: (world: WorldConfig) => Promise<ReadResult<T>>,
): Promise<ReadResult<T>> {
  if (!world || typeof world === "string") {
    return { ok: false, detail: world ?? "no rehearsal world was bound" };
  }
  return read(world);
}

async function getJson(world: WorldConfig, path: string): Promise<unknown> {
  const res = await eraFetch(world, path, {
    headers: { authorization: "Bearer rehearsal-verify" },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}

function live(body: { livemode?: boolean }): string | null {
  return body.livemode === true ? "the provider answered in live mode" : null;
}

async function listRefunds(
  world: WorldConfig,
  chargeId: string,
): Promise<ReadResult<{ complete: boolean; refunds: RefundView[] }>> {
  const refunds: RefundView[] = [];
  let path = `/v1/refunds?charge=${encodeURIComponent(chargeId)}&limit=100`;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    let body: unknown;
    try {
      body = await getJson(world, path);
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
    const parsed = RefundPage.safeParse(body);
    if (!parsed.success) return { ok: false, detail: "invalid refund page" };
    const refused = live(parsed.data);
    if (refused) return { ok: false, detail: refused };
    if (
      parsed.data.data.some((refund) => seen.has(refund.id)) ||
      new Set(parsed.data.data.map((refund) => refund.id)).size !== parsed.data.data.length
    ) {
      return { ok: false, detail: "repeated refund cursor" };
    }
    for (const refund of parsed.data.data) {
      seen.add(refund.id);
      if (!Number.isInteger(refund.amount) || !/^[a-z]{3}$/i.test(refund.currency)) {
        return { ok: false, detail: "a refund amount is not an integer number of minor units" };
      }
      refunds.push({
        id: refund.id,
        amountMinor: refund.amount,
        currency: refund.currency.toLowerCase(),
        status: refund.status,
        chargeId: refund.charge,
      });
    }
    if (!parsed.data.has_more) return { ok: true, value: { complete: true, refunds } };
    const last = parsed.data.data.at(-1);
    if (!last) return { ok: false, detail: "empty refund page with has_more" };
    path = `/v1/refunds?charge=${encodeURIComponent(chargeId)}&limit=100&starting_after=${encodeURIComponent(last.id)}`;
  }
  return { ok: true, value: { complete: false, refunds: [] } };
}

async function listCredits(
  world: WorldConfig,
  customerId: string,
): Promise<ReadResult<{ complete: boolean; credits: CreditView[] }>> {
  const credits: CreditView[] = [];
  let path = `/v1/customers/${encodeURIComponent(customerId)}/balance_transactions?limit=100`;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    let body: unknown;
    try {
      body = await getJson(world, path);
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
    const parsed = CreditPage.safeParse(body);
    if (!parsed.success) return { ok: false, detail: "invalid credit page" };
    const refused = live(parsed.data);
    if (refused) return { ok: false, detail: refused };
    if (
      parsed.data.data.some((credit) => seen.has(credit.id)) ||
      new Set(parsed.data.data.map((credit) => credit.id)).size !== parsed.data.data.length
    ) {
      return { ok: false, detail: "repeated credit cursor" };
    }
    for (const credit of parsed.data.data) {
      seen.add(credit.id);
      if (!Number.isInteger(credit.amount) || !/^[a-z]{3}$/i.test(credit.currency)) {
        return { ok: false, detail: "a credit amount is not an integer number of minor units" };
      }
      credits.push({
        id: credit.id,
        amountMinor: credit.amount,
        currency: credit.currency.toLowerCase(),
        type: credit.type,
        chargeId: credit.metadata?.charge ?? credit.metadata?.charge_id ?? null,
      });
    }
    if (!parsed.data.has_more) return { ok: true, value: { complete: true, credits } };
    const last = parsed.data.data.at(-1);
    if (!last) return { ok: false, detail: "empty credit page with has_more" };
    path = `/v1/customers/${encodeURIComponent(customerId)}/balance_transactions?limit=100&starting_after=${encodeURIComponent(last.id)}`;
  }
  return { ok: true, value: { complete: false, credits: [] } };
}

async function listCharges(
  world: WorldConfig,
  predicate: { customerId: string; createdGte: string; createdLt: string },
): Promise<ReadResult<{ complete: boolean; matchingIds: string[] }>> {
  const gte = Math.floor(Date.parse(predicate.createdGte) / 1000);
  const lt = Math.floor(Date.parse(predicate.createdLt) / 1000);
  if (!Number.isFinite(gte) || !Number.isFinite(lt)) {
    return { ok: false, detail: "the query window is not a timestamp" };
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      customer: predicate.customerId,
      "created[gte]": String(gte),
      "created[lt]": String(lt),
      limit: "100",
    });
    if (after) params.set("starting_after", after);
    let body: unknown;
    try {
      body = await getJson(world, `/v1/charges?${params}`);
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
    const parsed = ChargePage.safeParse(body);
    if (!parsed.success) return { ok: false, detail: "invalid charge page" };
    const refused = live(parsed.data);
    if (refused) return { ok: false, detail: refused };
    if (
      parsed.data.data.some((charge) => seen.has(charge.id)) ||
      new Set(parsed.data.data.map((charge) => charge.id)).size !== parsed.data.data.length
    ) {
      return { ok: false, detail: "repeated charge cursor" };
    }
    for (const charge of parsed.data.data) {
      seen.add(charge.id);
      // Keep every returned id. The control charge sits outside the window on purpose; dropping
      // it here would make that charge look absent and a benign rehearsal would pass.
      ids.push(charge.id);
    }
    if (!parsed.data.has_more) return { ok: true, value: { complete: true, matchingIds: ids } };
    const last = parsed.data.data.at(-1);
    if (!last) return { ok: false, detail: "empty charge page with has_more" };
    after = last.id;
  }
  return { ok: true, value: { complete: false, matchingIds: [] } };
}

async function readTicket(
  world: WorldConfig,
  ticketId: string,
): Promise<ReadResult<{ priority: string | null; status: string }>> {
  let body: unknown;
  try {
    body = await getJson(world, `/api/v2/tickets/${encodeURIComponent(ticketId)}.json`);
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
  const parsed = TicketBody.safeParse(body);
  if (!parsed.success) return { ok: false, detail: "invalid ticket" };
  return {
    ok: true,
    value: { priority: parsed.data.ticket.priority, status: parsed.data.ticket.status },
  };
}

async function listComments(
  world: WorldConfig,
  ticketId: string,
): Promise<ReadResult<{ complete: boolean; comments: { body: string; public: boolean }[] }>> {
  const comments: { body: string; public: boolean }[] = [];
  let path = `/api/v2/tickets/${encodeURIComponent(ticketId)}/comments.json`;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    if (seen.has(path)) return { ok: false, detail: "repeated comment cursor" };
    seen.add(path);
    let body: unknown;
    try {
      body = await getJson(world, path);
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
    const parsed = CommentPage.safeParse(body);
    if (!parsed.success) return { ok: false, detail: "invalid comment page" };
    comments.push(...parsed.data.comments);
    if (parsed.data.next_page === null) return { ok: true, value: { complete: true, comments } };
    let next: URL;
    try {
      next = new URL(parsed.data.next_page, world.baseUrl);
    } catch {
      return { ok: false, detail: "invalid comment cursor" };
    }
    if (next.origin !== new URL(world.baseUrl).origin || parsed.data.comments.length === 0) {
      return { ok: false, detail: "untrusted or empty comment page" };
    }
    path = `${next.pathname}${next.search}`;
  }
  return { ok: true, value: { complete: false, comments: [] } };
}

async function listSlack(
  world: WorldConfig,
  channelId: string,
): Promise<ReadResult<{ complete: boolean; texts: string[] }>> {
  const texts: string[] = [];
  let path = `/api/conversations.history?channel=${encodeURIComponent(channelId)}&limit=200`;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    if (seen.has(path)) return { ok: false, detail: "repeated Slack cursor" };
    seen.add(path);
    let body: unknown;
    try {
      body = await getJson(world, path);
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
    const parsed = SlackHistory.safeParse(body);
    if (!parsed.success) return { ok: false, detail: "invalid Slack history page" };
    if (!parsed.data.ok) {
      return { ok: false, detail: `Slack history: ${parsed.data.error ?? "not ok"}` };
    }
    for (const message of parsed.data.messages ?? []) {
      if (message.text !== undefined) texts.push(unescapeSlack(message.text));
    }
    const cursor = parsed.data.response_metadata?.next_cursor;
    if (!parsed.data.has_more) return { ok: true, value: { complete: true, texts } };
    if (!cursor) return { ok: false, detail: "more Slack history but no cursor" };
    path = `/api/conversations.history?channel=${encodeURIComponent(channelId)}&limit=200&cursor=${encodeURIComponent(cursor)}`;
  }
  return { ok: true, value: { complete: false, texts: [] } };
}

function unescapeSlack(text: string): string {
  return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}
