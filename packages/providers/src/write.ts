import type { Action, Attempt, World } from "@rehearsal/contracts";
import {
  type CreditAction,
  creditEffectMatches,
  type DispatchResult,
  noteBodyFor,
  operationMarker,
  type Preconditions,
  type PreparedRequest,
  type ProviderPort,
  type ReconcileResult,
  type ReplyAction,
  type ResolvedBindings,
  refundEffectMatches,
  replyCommentFor,
  type WorldContext,
} from "@rehearsal/core";
import { z } from "zod";
import { eraFetch } from "./era";
import type { WorldConfig } from "./worlds";

/** The write half of a ProviderPort. T1 owns the read half (observe, query). */
export type ProviderWriter = Pick<
  ProviderPort,
  | "vendor"
  | "preconditions"
  | "preconditionsOf"
  | "idempotentResend"
  | "prepare"
  | "dispatch"
  | "reconcile"
>;

/** One operational (or planning) world a writer is bound to. Chosen by the server, never a URL from a plan. */
export interface WriteTarget {
  world: World;
  config: WorldConfig;
  /** Value for the vendor's Authorization header. The simulators accept any bearer. */
  authorization: string;
  /** Per-request timeout; a timeout is an unknown outcome, never a rejection. */
  timeoutMs?: number;
}

function assertTarget(target: WriteTarget, ctx: WorldContext) {
  if (ctx.world !== target.world || ctx.tenant !== target.config.tenant) {
    throw new Error(
      `writer is bound to ${target.world}/${target.config.tenant}, asked to write to ${ctx.world}/${ctx.tenant}`,
    );
  }
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/**
 * How a response maps to an outcome. Only a definite refusal is `rejected`: 429 (retryable, no
 * effect) and other 4xx (no effect). A 5xx may have committed, so it is `unknown`, like a lost
 * response; reconciliation decides, never a blind re-send.
 */
export function classifyResponse(
  status: number,
  body: unknown,
  retryAfter: string | null,
): DispatchResult {
  if (status >= 200 && status < 300) return { kind: "confirmed", status, body };
  if (status === 429) {
    const ms = retryAfterMs(retryAfter);
    return {
      kind: "rejected",
      status,
      body,
      retryable: true,
      ...(ms !== undefined && { retryAfterMs: ms }),
    };
  }
  if (status >= 500)
    return { kind: "unknown", error: `provider answered ${status}; effect unknown` };
  return { kind: "rejected", status, body, retryable: false };
}

/** Send the exact journaled bytes. Any transport failure after sending is an unknown outcome. */
async function send(target: WriteTarget, req: PreparedRequest): Promise<DispatchResult> {
  const headers: Record<string, string> = {
    ...req.headers,
    authorization: target.authorization,
    "content-type":
      req.encoding === "form" ? "application/x-www-form-urlencoded" : "application/json",
  };
  let res: Response;
  let text: string;
  try {
    res = await eraFetch(target.config, req.path, {
      method: req.method,
      headers,
      body: req.body,
      signal: AbortSignal.timeout(target.timeoutMs ?? 10_000),
    });
    text = await res.text();
  } catch (err) {
    return { kind: "unknown", error: `transport: ${(err as Error).message}` };
  }
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Keep the raw text; a confirmed but unreadable body becomes unknown in the executor.
  }
  return classifyResponse(res.status, body, res.headers.get("retry-after"));
}

/** GET through the bound tenant with the vendor auth; throws on a non-2xx (reconcile → indeterminate). */
async function readJson<T>(target: WriteTarget, path: string): Promise<T> {
  const res = await eraFetch(target.config, path, {
    headers: { authorization: target.authorization },
    signal: AbortSignal.timeout(target.timeoutMs ?? 10_000),
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return (await res.json()) as T;
}

const MAX_PAGES = 50;
const RefundPage = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      status: z.string().min(1),
      amount: z.int().nonnegative(),
      currency: z.string().regex(/^[a-z]{3}$/),
      charge: z.string().min(1),
      metadata: z.record(z.string(), z.string()).optional(),
    }),
  ),
  has_more: z.boolean(),
});
const CommentPage = z.object({
  comments: z.array(
    z.object({
      id: z.union([z.number(), z.string()]).optional(),
      body: z.string(),
      public: z.boolean(),
    }),
  ),
  next_page: z.string().min(1).nullable(),
});
type Comment = z.infer<typeof CommentPage>["comments"][number];

/** Find the comment carrying `marker` across every page of a ticket's comments. */
async function findMarkedComment(
  target: WriteTarget,
  ticketId: string,
  marker: string,
): Promise<
  { kind: "found"; comment: Comment } | { kind: "absent" } | { kind: "unknown"; detail: string }
> {
  let path = `/api/v2/tickets/${encodeURIComponent(ticketId)}/comments.json`;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    if (seen.has(path)) return { kind: "unknown", detail: "repeated comment cursor" };
    seen.add(path);
    const parsed = CommentPage.safeParse(await readJson<unknown>(target, path));
    if (!parsed.success) return { kind: "unknown", detail: "invalid comment page" };
    const body = parsed.data;
    const comment = body.comments.find((c) => c.body.includes(marker));
    if (comment) return { kind: "found", comment };
    if (body.next_page === null) return { kind: "absent" };
    let next: URL;
    try {
      next = new URL(body.next_page, target.config.baseUrl);
    } catch {
      return { kind: "unknown", detail: "invalid comment cursor" };
    }
    if (next.origin !== new URL(target.config.baseUrl).origin || body.comments.length === 0) {
      return { kind: "unknown", detail: "untrusted or empty comment page" };
    }
    path = `${next.pathname}${next.search}`;
  }
  return { kind: "unknown", detail: `more than ${MAX_PAGES} pages of comments` };
}

/**
 * Stripe refunds. Form-encoded in a fixed field order (the simulator fingerprints path + raw body
 * bytes), idempotency key = operation key, and the key also stored in metadata so a later read can
 * find the refund.
 */
export function stripeWriter(target: WriteTarget): ProviderWriter {
  return {
    vendor: "stripe",
    // Same key + same bytes either creates the refund once or replays the original response.
    idempotentResend: (action: Action) => action.kind === "stripe.refund.create",
    prepare(action: Action, _bindings: ResolvedBindings, operationKey: string): PreparedRequest {
      if (action.kind !== "stripe.refund.create") throw new Error(`stripe can't ${action.kind}`);
      const body = new URLSearchParams([
        ["charge", action.args.chargeId],
        ["amount", String(action.args.amount.amountMinor)],
        ["reason", action.args.reason],
        ["metadata[rehearsal_op]", operationKey],
      ]).toString();
      return {
        method: "POST",
        path: "/v1/refunds",
        encoding: "form",
        body,
        headers: { "idempotency-key": operationKey },
      };
    },
    async dispatch(req: PreparedRequest, ctx: WorldContext) {
      assertTarget(target, ctx);
      const result = await send(target, req);
      // 409 here means the key is in use by a concurrent request that may still apply.
      if (result.kind === "rejected" && result.status === 409) {
        return { kind: "unknown", error: "idempotency key in use by a concurrent request" };
      }
      return result;
    },
    /** Find the refund by the operation key stored in its metadata, among all refunds of the charge. */
    async reconcile(attempt: Attempt, action: Action, ctx: WorldContext): Promise<ReconcileResult> {
      assertTarget(target, ctx);
      if (action.kind !== "stripe.refund.create") throw new Error(`stripe can't ${action.kind}`);
      let path = `/v1/refunds?charge=${encodeURIComponent(action.args.chargeId)}&limit=100`;
      const seen = new Set<string>();
      for (let page = 0; page < MAX_PAGES; page++) {
        const parsed = RefundPage.safeParse(await readJson<unknown>(target, path));
        if (!parsed.success) return { kind: "indeterminate", detail: "invalid refund page" };
        const list = parsed.data;
        if (
          list.data.some((r) => seen.has(r.id)) ||
          new Set(list.data.map((r) => r.id)).size !== list.data.length
        )
          return { kind: "indeterminate", detail: "repeated refund cursor" };
        for (const refund of list.data) seen.add(refund.id);
        const refund = list.data.find((r) => r.metadata?.rehearsal_op === attempt.operationKey);
        if (refund) {
          const effect = {
            "refund.id": refund.id,
            "refund.status": refund.status,
            "refund.amount": refund.amount,
            charge: refund.charge,
            currency: refund.currency,
          };
          // A changed revision may be reconciling older content: correlate to the bytes
          // that were actually dispatched, then let the executor compare revisions.
          const sent = new URLSearchParams(attempt.request.body);
          const original = {
            ...action,
            args: {
              ...action.args,
              chargeId: sent.get("charge") ?? "",
              amount: { ...action.args.amount, amountMinor: Number(sent.get("amount")) },
            },
          };
          if (!refundEffectMatches(original, effect)) {
            return {
              kind: "indeterminate",
              detail: "refund read contradicts the journaled operation",
            };
          }
          return {
            kind: "applied",
            providerRef: { vendor: "stripe", kind: "refund", id: refund.id },
            effect,
          };
        }
        const last = list.data.at(-1);
        if (!list.has_more) return { kind: "not_applied" };
        if (!last) return { kind: "indeterminate", detail: "empty refund page with has_more" };
        path = `/v1/refunds?charge=${encodeURIComponent(action.args.chargeId)}&limit=100&starting_after=${encodeURIComponent(last.id)}`;
      }
      return { kind: "indeterminate", detail: `more than ${MAX_PAGES} pages of refunds` };
    },
  };
}

const ticketPath = (id: string) => `/api/v2/tickets/${encodeURIComponent(id)}.json`;

/** The `updated_stamp` a journaled Zendesk body was prepared with, if any. */
function stampIn(body: string): Preconditions {
  try {
    const stamp = (JSON.parse(body) as { ticket?: { updated_stamp?: unknown } }).ticket
      ?.updated_stamp;
    return typeof stamp === "string" ? { updated_stamp: stamp } : {};
  } catch {
    return {};
  }
}

/**
 * Zendesk ticket writes over REST. A field patch is guarded with `safe_update` + the
 * `updated_stamp` read just before (a native guard with a documented 1-second limit). A private
 * note always sends `public: false` explicitly, because REST defaults comments to public.
 */
export function zendeskWriter(target: WriteTarget): ProviderWriter {
  return {
    vendor: "zendesk",
    async preconditions(action: Action, ctx: WorldContext): Promise<Preconditions> {
      assertTarget(target, ctx);
      if (action.kind !== "zendesk.ticket.patchFields") return {};
      const res = await eraFetch(target.config, ticketPath(action.args.ticketId), {
        headers: { authorization: target.authorization },
        signal: AbortSignal.timeout(target.timeoutMs ?? 10_000),
      });
      if (!res.ok) throw new Error(`GET ticket ${action.args.ticketId} → ${res.status}`);
      const { ticket } = (await res.json()) as { ticket?: { updated_at?: unknown } };
      if (typeof ticket?.updated_at !== "string") throw new Error("ticket has no updated_at");
      return { updated_stamp: ticket.updated_at };
    },
    preconditionsOf(request: Attempt["request"]): Preconditions {
      return stampIn(request.body);
    },
    prepare(
      action: Action,
      bindings: ResolvedBindings,
      operationKey: string,
      pre: Preconditions = {},
    ): PreparedRequest {
      if (action.kind === "zendesk.ticket.patchFields") {
        const stamp = pre.updated_stamp;
        if (!stamp) throw new Error("guarded patch needs an updated_stamp precondition");
        // Explicit key order keeps the bytes deterministic.
        const ticket: Record<string, unknown> = {};
        if (action.args.set.priority !== undefined) ticket.priority = action.args.set.priority;
        if (action.args.set.status !== undefined) ticket.status = action.args.set.status;
        ticket.safe_update = true;
        ticket.updated_stamp = stamp;
        return {
          method: "PUT",
          path: ticketPath(action.args.ticketId),
          encoding: "json",
          body: JSON.stringify({ ticket }),
          headers: {},
        };
      }
      if (action.kind === "zendesk.ticket.appendPrivateNote") {
        const body = noteBodyFor(action, bindings, operationKey);
        return {
          method: "PUT",
          path: ticketPath(action.args.ticketId),
          encoding: "json",
          body: JSON.stringify({ ticket: { comment: { body, public: false } } }),
          headers: {},
        };
      }
      throw new Error(`zendesk can't ${action.kind}`);
    },
    async dispatch(req: PreparedRequest, ctx: WorldContext) {
      assertTarget(target, ctx);
      return send(target, req);
    },
    async reconcile(attempt: Attempt, action: Action, ctx: WorldContext): Promise<ReconcileResult> {
      assertTarget(target, ctx);
      if (action.kind === "stripe.refund.create") throw new Error(`zendesk can't ${action.kind}`);
      const ref = { vendor: "zendesk", kind: "ticket", id: action.args.ticketId } as const;
      if (action.kind === "zendesk.ticket.appendPrivateNote") {
        // The note carries its operation marker; look for it across every page of comments.
        const found = await findMarkedComment(
          target,
          action.args.ticketId,
          operationMarker(attempt.operationKey),
        );
        if (found.kind === "found") return { kind: "applied", providerRef: ref, effect: {} };
        if (found.kind === "absent") return { kind: "not_applied" };
        return { kind: "indeterminate", detail: found.detail };
      }
      if (action.kind === "zendesk.ticket.patchFields") {
        const { ticket } = await readJson<{ ticket: Record<string, unknown> }>(
          target,
          ticketPath(action.args.ticketId),
        );
        const observed = {
          priority: ticket.priority,
          status: ticket.status,
          updated_at: ticket.updated_at,
        };
        const ours = Object.entries(action.args.set).every(
          ([field, value]) => value === undefined || ticket[field] === value,
        );
        if (ours) return { kind: "applied", providerRef: ref, effect: observed };
        // Untouched since the read our guarded write was based on: it never landed.
        if (stampIn(attempt.request.body).updated_stamp === ticket.updated_at)
          return { kind: "not_applied" };
        return {
          kind: "indeterminate",
          detail:
            "ticket changed since our read and doesn't hold our values; can't tell whose write won",
        };
      }
      return { kind: "indeterminate", detail: "unsupported zendesk action" };
    },
  };
}

/** The write side of `zendesk.ticket.appendPublicReply` (T3.11); `executeRun` takes it once T1.13 adds the op. */
export interface ZendeskReplyWriter {
  vendor: "zendesk";
  prepare(action: ReplyAction, operationKey: string): PreparedRequest;
  dispatch(req: PreparedRequest, ctx: WorldContext): Promise<DispatchResult>;
  reconcile(attempt: Attempt, action: ReplyAction, ctx: WorldContext): Promise<ReconcileResult>;
}

/**
 * Public customer replies. The comment is the approved body (re-rendered from its template and
 * checked byte for byte) plus the operation marker, sent with explicit `public: true`. Zendesk has
 * no exactly-once append, so there is no idempotent re-send: an unknown outcome is resolved by
 * reading the ticket's comments for the marker, and the found comment must be exactly what was
 * sent and public.
 */
export function zendeskReplyWriter(target: WriteTarget): ZendeskReplyWriter {
  return {
    vendor: "zendesk",
    prepare(action, operationKey) {
      return {
        method: "PUT",
        path: ticketPath(action.args.ticketId),
        encoding: "json",
        body: JSON.stringify({
          ticket: { comment: { body: replyCommentFor(action, operationKey), public: true } },
        }),
        headers: {},
      };
    },
    async dispatch(req, ctx) {
      assertTarget(target, ctx);
      return send(target, req);
    },
    async reconcile(attempt, action, ctx) {
      assertTarget(target, ctx);
      const found = await findMarkedComment(
        target,
        action.args.ticketId,
        operationMarker(attempt.operationKey),
      );
      if (found.kind === "absent") return { kind: "not_applied" };
      if (found.kind === "unknown") return { kind: "indeterminate", detail: found.detail };
      let sent: unknown;
      try {
        sent = (JSON.parse(attempt.request.body) as { ticket?: { comment?: { body?: unknown } } })
          .ticket?.comment?.body;
      } catch {
        return { kind: "indeterminate", detail: "journaled reply request is unreadable" };
      }
      if (found.comment.body !== sent || !found.comment.public) {
        return {
          kind: "indeterminate",
          detail: "a comment carries this reply's marker but isn't the public text that was sent",
        };
      }
      return {
        kind: "applied",
        providerRef: { vendor: "zendesk", kind: "ticket", id: action.args.ticketId },
        effect: {
          ...(found.comment.id !== undefined && { "comment.id": String(found.comment.id) }),
          public: true,
        },
      };
    },
  };
}

const BalanceTransactionPage = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      amount: z.number(),
      currency: z.string(),
      customer: z.string(),
      type: z.string(),
      metadata: z.record(z.string(), z.string()).nullable().optional(),
    }),
  ),
  has_more: z.boolean(),
});

/** The write side of `stripe.customer.balanceCredit` (T3.12); `executeRun` takes it once T1.14 adds the op. */
export interface StripeCreditWriter {
  vendor: "stripe";
  idempotentResend(action: CreditAction): boolean;
  preconditions(action: CreditAction, ctx: WorldContext): Promise<Preconditions>;
  prepare(action: CreditAction, operationKey: string): PreparedRequest;
  dispatch(req: PreparedRequest, ctx: WorldContext): Promise<DispatchResult>;
  reconcile(attempt: Attempt, action: CreditAction, ctx: WorldContext): Promise<ReconcileResult>;
}

/**
 * Customer balance credits: a negative customer balance transaction, form-encoded in a fixed
 * order, with the operation key as the idempotency key and in metadata (T1.19 showed Era replays
 * the same key and bytes and refuses other bytes). Era takes any currency, Stripe doesn't, so the
 * customer's currency is checked before the credit is prepared.
 */
export function stripeCreditWriter(target: WriteTarget): StripeCreditWriter {
  const path = (customerId: string) =>
    `/v1/customers/${encodeURIComponent(customerId)}/balance_transactions`;
  return {
    vendor: "stripe",
    idempotentResend: () => true,
    async preconditions(action, ctx) {
      assertTarget(target, ctx);
      const customer = await readJson<{ currency?: unknown }>(
        target,
        `/v1/customers/${encodeURIComponent(action.args.customerId)}`,
      );
      // A customer without a currency takes the first balance transaction's, as Stripe does.
      if (customer.currency !== null && customer.currency !== undefined) {
        if (customer.currency !== action.args.amount.currency) {
          throw new Error(
            `customer ${action.args.customerId} is in ${String(customer.currency)}, the credit is in ${action.args.amount.currency}`,
          );
        }
      }
      return {};
    },
    prepare(action, operationKey) {
      if (
        !Number.isInteger(action.args.amount.amountMinor) ||
        action.args.amount.amountMinor <= 0
      ) {
        throw new Error("a balance credit must be a positive integer amount");
      }
      const body = new URLSearchParams([
        ["amount", String(-action.args.amount.amountMinor)],
        ["currency", action.args.amount.currency],
        ["metadata[rehearsal_op]", operationKey],
      ]).toString();
      return {
        method: "POST",
        path: path(action.args.customerId),
        encoding: "form",
        body,
        headers: { "idempotency-key": operationKey },
      };
    },
    async dispatch(req, ctx) {
      assertTarget(target, ctx);
      const result = await send(target, req);
      // 409 here means the key is in use by a concurrent request that may still apply.
      if (result.kind === "rejected" && result.status === 409) {
        return { kind: "unknown", error: "idempotency key in use by a concurrent request" };
      }
      return result;
    },
    /** Find the credit by the operation key in its metadata, among all the customer's transactions. */
    async reconcile(attempt, action, ctx) {
      assertTarget(target, ctx);
      let page = `${path(action.args.customerId)}?limit=100`;
      const seen = new Set<string>();
      for (let n = 0; n < MAX_PAGES; n++) {
        const parsed = BalanceTransactionPage.safeParse(await readJson<unknown>(target, page));
        if (!parsed.success)
          return { kind: "indeterminate", detail: "invalid balance transaction page" };
        const list = parsed.data;
        if (list.data.some((t) => seen.has(t.id))) {
          return { kind: "indeterminate", detail: "repeated balance transaction cursor" };
        }
        for (const t of list.data) seen.add(t.id);
        const tx = list.data.find((t) => t.metadata?.rehearsal_op === attempt.operationKey);
        if (tx) {
          const effect = {
            "credit.id": tx.id,
            "credit.amount": tx.amount,
            "credit.type": tx.type,
            customer: tx.customer,
            currency: tx.currency,
          };
          // Correlate to the bytes that were actually dispatched (a revision may differ).
          const sent = new URLSearchParams(attempt.request.body);
          const original: CreditAction = {
            ...action,
            args: {
              ...action.args,
              amount: {
                amountMinor: -Number(sent.get("amount")),
                currency: sent.get("currency") ?? "",
              },
            },
          };
          if (!creditEffectMatches(original, effect)) {
            return {
              kind: "indeterminate",
              detail: "credit read contradicts the journaled operation",
            };
          }
          return {
            kind: "applied",
            providerRef: { vendor: "stripe", kind: "customer_balance_transaction", id: tx.id },
            effect,
          };
        }
        const last = list.data.at(-1);
        if (!list.has_more) return { kind: "not_applied" };
        if (!last)
          return { kind: "indeterminate", detail: "empty balance transaction page with has_more" };
        page = `${path(action.args.customerId)}?limit=100&starting_after=${encodeURIComponent(last.id)}`;
      }
      return {
        kind: "indeterminate",
        detail: `more than ${MAX_PAGES} pages of balance transactions`,
      };
    },
  };
}

/** Join T1's read half with this write half into one ProviderPort. */
export function withWriter(
  read: Pick<ProviderPort, "observe" | "query">,
  write: ProviderWriter,
): ProviderPort {
  return { ...write, observe: read.observe, query: read.query };
}

/** Until T1's read adapters land: a port whose reads refuse loudly instead of guessing. */
export function writeOnly(write: ProviderWriter): ProviderPort {
  const refuse = async (): Promise<never> => {
    throw new Error(`${write.vendor} read side is not wired yet (T1.3)`);
  };
  return withWriter({ observe: refuse, query: refuse }, write);
}
