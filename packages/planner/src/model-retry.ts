import type Anthropic from "@anthropic-ai/sdk";
import type { MessagesClient } from "./loop";

export interface ModelAttempt {
  turn: number;
  attempt: number;
  outcome:
    | "succeeded"
    | "timeout"
    | "rate_limit"
    | "network"
    | "server_error"
    | "error"
    | "aborted";
  /** Reserved even for an unanswered request: its provider-side token use is unknown. */
  reservedOutputTokens: number;
}

export interface ModelRequestBudget {
  requests: number;
  reservedOutputTokens: number;
}

export interface ModelRetryLimits {
  maxModelRequests: number;
  maxOutputTokens: number;
  requestTimeoutMs: number;
  maxRequestAttempts: number;
  retryDelayMs: number;
}

export class ModelRequestError extends Error {
  constructor(
    readonly reason: "model_request_limit" | "model_token_limit",
    message: string,
  ) {
    super(message);
  }
}

/** Retry model transport only. A successful response's tool calls are processed exactly once. */
export async function requestModel(
  client: MessagesClient,
  params: Anthropic.MessageCreateParamsNonStreaming,
  opts: {
    turn: number;
    limits: ModelRetryLimits;
    budget: ModelRequestBudget;
    signal?: AbortSignal;
    onAttempt?: (attempt: ModelAttempt) => void;
  },
): Promise<Anthropic.Message> {
  const { limits, budget } = opts;
  for (let attempt = 1; ; attempt++) {
    opts.signal?.throwIfAborted();
    if (budget.requests >= limits.maxModelRequests) {
      throw new ModelRequestError("model_request_limit", "model request budget exhausted");
    }
    if (budget.reservedOutputTokens + params.max_tokens > limits.maxOutputTokens) {
      throw new ModelRequestError("model_token_limit", "model output-token budget exhausted");
    }
    budget.requests++;
    budget.reservedOutputTokens += params.max_tokens;
    const timeout = AbortSignal.timeout(limits.requestTimeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let response: Anthropic.Message;
    try {
      response = await untilAborted(client.create(params, { signal }), signal);
      signal.throwIfAborted();
    } catch (error) {
      const outcome = opts.signal?.aborted
        ? "aborted"
        : timeout.aborted
          ? "timeout"
          : classify(error);
      opts.onAttempt?.({
        turn: opts.turn,
        attempt,
        outcome,
        reservedOutputTokens: params.max_tokens,
      });
      opts.signal?.throwIfAborted();
      if (outcome === "error" || attempt >= limits.maxRequestAttempts) throw error;
      // Sleep is also covered by the overall job deadline.
      await backoff(Math.min(limits.retryDelayMs * 2 ** (attempt - 1), 5_000), opts.signal);
      continue;
    }
    opts.onAttempt?.({
      turn: opts.turn,
      attempt,
      outcome: "succeeded",
      reservedOutputTokens: params.max_tokens,
    });
    return response;
  }
}

function classify(error: unknown): ModelAttempt["outcome"] {
  if (!(error instanceof Error)) return "error";
  const e = error as Error & { status?: number; code?: string; cause?: unknown };
  if (e.status === 429) return "rate_limit";
  if (e.status === 408 || e.name === "TimeoutError" || e.name === "APIConnectionTimeoutError")
    return "timeout";
  if ([500, 502, 503, 504].includes(e.status ?? 0)) return "server_error";
  // An explicit non-transient HTTP status (notably 400/401/403) must not be retried.
  if (e.status !== undefined) return "error";
  if (e.name === "APIConnectionError" || (e instanceof TypeError && e.message === "fetch failed"))
    return "network";
  if (
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_SOCKET",
    ].includes(e.code ?? "")
  )
    return "network";
  return "error";
}

function backoff(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Ignore late responses even when a client fails to honour the abort signal. */
export function untilAborted<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
