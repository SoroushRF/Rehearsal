import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ModelAttempt, requestModel } from "../src/model-retry";
import { LOOP_LIMITS } from "../src/prompt";

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
    [http(408), "timeout"],
    [http(409), "conflict"],
    [http(501), "server_error"],
    [http(599), "server_error"],
    [
      Anthropic.APIError.generate(
        529,
        { error: { type: "overloaded_error" } },
        "overloaded",
        new Headers(),
      ),
      "server_error",
    ],
    [new Anthropic.APIConnectionError({ cause: new TypeError("fetch failed") }), "network"],
    [
      new Anthropic.APIConnectionError({
        cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
      }),
      "network",
    ],
    [new Anthropic.APIConnectionTimeoutError(), "timeout"],
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
    const settled = run.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await vi.runAllTimersAsync();
    expect(await settled).toEqual({ value: response });
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

  it.each([1, 4])("leaves room for %i retries and all forty default turns", async (retries) => {
    vi.useFakeTimers();
    const budget = { requests: 0, reservedOutputTokens: 0 };
    const retried = new WeakSet<object>();
    let failures = 0;
    const create = vi.fn(async (request: Anthropic.MessageCreateParamsNonStreaming) => {
      if (failures < retries && !retried.has(request)) {
        retried.add(request);
        failures++;
        throw http(429);
      }
      return response;
    });
    const run = (async () => {
      for (let turn = 1; turn <= LOOP_LIMITS.maxTurns; turn++) {
        await requestModel(
          { create },
          { ...params, max_tokens: LOOP_LIMITS.maxTokensPerTurn },
          { turn, limits: LOOP_LIMITS, budget },
        );
      }
    })();
    const completed = run.then(
      () => null,
      (error) => error,
    );
    await vi.runAllTimersAsync();
    expect(await completed).toBeNull();
    expect(create).toHaveBeenCalledTimes(40 + retries);
    expect(budget.reservedOutputTokens).toBe((40 + retries) * 16_000);
    if (retries === 4) {
      await expect(
        requestModel({ create }, params, { turn: 41, limits: LOOP_LIMITS, budget }),
      ).rejects.toMatchObject({ reason: "model_request_limit" });
    }
  });

  it.each([
    [{ "retry-after-ms": "750" }, 750],
    [{ "retry-after": "1.25" }, 1250],
    [{ "retry-after": "Wed, 28 Oct 2026 12:00:02 GMT" }, 2000],
    [{ "retry-after-ms": "100", "retry-after": "1" }, 100],
    [{ "retry-after-ms": "bad", "retry-after": "0.025" }, 25],
    [{ "retry-after": "-1" }, 10],
    [{ "retry-after": "Infinity" }, 10],
    [{ "retry-after-ms": "4294967296" }, 10],
    [{ "retry-after": "Wed, 28 Oct 2026 11:00:00 GMT" }, 10],
  ] as const)(
    "honours valid provider hints and safely falls back for %s",
    async (headers, delay) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
      const at: number[] = [];
      const error = Anthropic.APIError.generate(429, {}, "rate limited", new Headers(headers));
      const create = vi.fn(async () => {
        at.push(Date.now());
        if (at.length === 1) throw error;
        return response;
      });
      const run = requestModel({ create }, params, {
        turn: 1,
        limits,
        budget: { requests: 0, reservedOutputTokens: 0 },
      });
      const settled = run.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await vi.runAllTimersAsync();
      expect(await settled).toEqual({ value: response });
      expect((at[1] ?? 0) - (at[0] ?? 0)).toBe(delay);
    },
  );

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
    const create = vi
      .fn()
      .mockRejectedValue(
        Anthropic.APIError.generate(429, {}, "rate limited", new Headers({ "retry-after": "600" })),
      );
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
