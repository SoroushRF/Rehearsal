import type { Action, Attempt, World } from "@rehearsal/contracts";
import {
  type DispatchResult,
  noteBodyFor,
  type Preconditions,
  type PreparedRequest,
  type ProviderPort,
  type ReconcileResult,
  type ResolvedBindings,
  type WorldContext,
} from "@rehearsal/core";
import { eraFetch } from "./era";
import type { WorldConfig } from "./worlds";

/** The write half of a ProviderPort. T1 owns the read half (observe, query). */
export type ProviderWriter = Pick<
  ProviderPort,
  "vendor" | "preconditions" | "preconditionsOf" | "prepare" | "dispatch" | "reconcile"
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

const notYet = async (): Promise<ReconcileResult> => ({
  kind: "indeterminate",
  detail: "reconciliation through reads lands in T3.5",
});

/**
 * Stripe refunds. Form-encoded in a fixed field order (the simulator fingerprints path + raw body
 * bytes), idempotency key = operation key, and the key also stored in metadata so a later read can
 * find the refund.
 */
export function stripeWriter(target: WriteTarget): ProviderWriter {
  return {
    vendor: "stripe",
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
    reconcile: (_a: Attempt, _action: Action, _ctx: WorldContext) => notYet(),
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
    reconcile: (_a: Attempt, _action: Action, _ctx: WorldContext) => notYet(),
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
