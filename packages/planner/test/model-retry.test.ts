import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ModelAttempt, requestModel } from "../src/model-retry";

const params = {
  model: "pinned",
  max_tokens: 100,
  messages: [],
} as Anthropic.MessageCreateParamsNonStreaming;
const response = { id: "ok" } as Anthropic.Message;
const limits = {
  maxModelRequests: 4,
  maxOutputTokens: 400,
  requestTimeoutMs: 50,
  maxRequestAttempts: 3,
  retryDelayMs: 10,
};
const http = (status: number) => Object.assign(new Error("provider error"), { status });

afterEach(() => vi.useRealTimers());

describe("bounded model transport recovery", () => {
  it.each([
    [http(429), "rate_limit"],
    [http(503), "server_error"],
    [new TypeError("fetch failed"), "network"],
    [Object.assign(new Error("socket closed"), { code: "ECONNRESET" }), "network"],
    [new DOMException("request timed out", "TimeoutError"), "timeout"],
  ])("recovers from %s without changing the request", async (error, outcome) => {
    vi.useFakeTimers();
    const attempts: ModelAttempt[] = [];
    const create = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(response);
    const budget = { requests: 0, reservedOutputTokens: 0 };
    const run = requestModel({ create }, params, {
      turn: 2,
      limits,
      budget,
      onAttempt: (a) => attempts.push(a),
    });
    await vi.runAllTimersAsync();
    expect(await run).toBe(response);
    expect(create.mock.calls.map(([request]) => request)).toEqual([params, params]);
    expect(attempts.map((a) => [a.turn, a.attempt, a.outcome])).toEqual([
      [2, 1, outcome],
      [2, 2, "succeeded"],
    ]);
    expect(budget).toEqual({ requests: 2, reservedOutputTokens: 200 });
  });

  it.each([400, 401, 403, 404, 422])("does not retry HTTP %i", async (status) => {
    const create = vi.fn().mockRejectedValue(http(status));
    await expect(
      requestModel({ create }, params, {
        turn: 1,
        limits,
        budget: { requests: 0, reservedOutputTokens: 0 },
      }),
    ).rejects.toMatchObject({ status });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("backs off exponentially and stops after three failed requests", async () => {
    vi.useFakeTimers();
    const at: number[] = [];
    const create = vi.fn(async () => {
      at.push(Date.now());
      throw http(429);
    });
    const run = requestModel({ create }, params, {
      turn: 1,
      limits,
      budget: { requests: 0, reservedOutputTokens: 0 },
    });
    const failed = expect(run).rejects.toMatchObject({ status: 429 });
    await vi.runAllTimersAsync();
    await failed;
    expect(at.map((t) => t - (at[0] ?? 0))).toEqual([0, 10, 30]);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it.each([
    [{ requests: 4, reservedOutputTokens: 0 }, "model_request_limit"],
    [{ requests: 0, reservedOutputTokens: 350 }, "model_token_limit"],
  ])("never sends beyond a run-wide budget", async (budget, reason) => {
    const create = vi.fn();
    await expect(
      requestModel({ create }, params, { turn: 1, limits, budget }),
    ).rejects.toMatchObject({ reason });
    expect(create).not.toHaveBeenCalled();
  });

  it("times out an uncooperative client, retries, and ignores its late response", async () => {
    let resolveLate: (m: Anthropic.Message) => void = () => {};
    const late = new Promise<Anthropic.Message>((resolve) => {
      resolveLate = resolve;
    });
    const attempts: ModelAttempt[] = [];
    const create = vi.fn().mockReturnValueOnce(late).mockResolvedValue(response);
    const run = requestModel({ create }, params, {
      turn: 1,
      limits: { ...limits, requestTimeoutMs: 10, retryDelayMs: 1 },
      budget: { requests: 0, reservedOutputTokens: 0 },
      onAttempt: (a) => attempts.push(a),
    });
    expect(await run).toBe(response);
    resolveLate({ id: "late" } as Anthropic.Message);
    await Promise.resolve();
    expect(attempts.map((a) => a.outcome)).toEqual(["timeout", "succeeded"]);
    expect(create.mock.calls[0]?.[1].signal.aborted).toBe(true);
  });

  it("aborts a stalled request at the overall deadline without retrying", async () => {
    const controller = new AbortController();
    const create = vi.fn(() => new Promise<Anthropic.Message>(() => {}));
    const attempts: ModelAttempt[] = [];
    const run = requestModel({ create }, params, {
      turn: 1,
      limits,
      budget: { requests: 0, reservedOutputTokens: 0 },
      signal: controller.signal,
      onAttempt: (a) => attempts.push(a),
    });
    controller.abort(new Error("job deadline"));
    await expect(run).rejects.toThrow("job deadline");
    expect(create).toHaveBeenCalledTimes(1);
    expect(attempts[0]?.outcome).toBe("aborted");
  });

  it("aborts backoff without sending another request", async () => {
    const controller = new AbortController();
    const create = vi.fn().mockRejectedValue(http(429));
    const run = requestModel({ create }, params, {
      turn: 1,
      limits: { ...limits, retryDelayMs: 5_000 },
      budget: { requests: 0, reservedOutputTokens: 0 },
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 1));
    controller.abort();
    await expect(run).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1);
  });
});
