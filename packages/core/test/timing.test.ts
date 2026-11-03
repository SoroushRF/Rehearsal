import { describe, expect, it } from "vitest";
import type { ProviderPort } from "../src/ports";
import { firstReadAt, pathTimings, RunMeter } from "../src/timing";

/** A clock the test moves by hand. */
function manualClock() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** Every call takes `ms` on the manual clock; `dispatch` throws when told to. */
function stubPort(
  clock: ReturnType<typeof manualClock>,
  ms = 10,
): ProviderPort & { self: unknown[] } {
  const self: unknown[] = [];
  const slow = async <T>(value: T) => {
    clock.advance(ms);
    return value;
  };
  const port: ProviderPort & { self: unknown[] } = {
    vendor: "stripe",
    self,
    observe(entity) {
      self.push(this);
      return slow({ entity } as never);
    },
    query: () => slow({} as never),
    preconditions: () => slow({} as never),
    preconditionsOf: () => ({}) as never,
    prepare: () => ({ body: "x" }) as never,
    async dispatch() {
      clock.advance(ms);
      throw new Error("socket hang up");
    },
    reconcile: () => slow({} as never),
    idempotentResend: () => true,
  };
  return port;
}

describe("T3.20 RunMeter", () => {
  it("counts the executor's calls by method", async () => {
    const clock = manualClock();
    const meter = new RunMeter(clock.now);
    const port = stubPort(clock);
    const stripe = meter.providers({ stripe: port }).stripe;
    if (!stripe) throw new Error("no port");

    await stripe.observe({ vendor: "stripe", kind: "charge", id: "ch_1" }, {} as never);
    await stripe.query({} as never, "", {} as never);
    await stripe.preconditions?.({} as never, {} as never);
    await expect(stripe.dispatch({} as never, {} as never)).rejects.toThrow("socket hang up");
    await stripe.reconcile({} as never, {} as never, {} as never);
    stripe.prepare({} as never, {} as never, "k");
    stripe.preconditionsOf?.({} as never);
    expect(stripe.idempotentResend?.({} as never)).toBe(true);

    const t = meter.timings({ planningMs: 1, approvalWaitMs: 2, queueMs: 3 }, 4);
    expect(t.calls.read).toEqual({ calls: 2, failed: 0, ms: 20 });
    expect(t.calls.precondition).toEqual({ calls: 1, failed: 0, ms: 10 });
    expect(t.calls.write).toEqual({ calls: 1, failed: 1, ms: 10 });
    expect(t.calls.reconcile).toEqual({ calls: 1, failed: 0, ms: 10 });
    expect(t.calls.guard.calls).toBe(0);
    expect(t.executeMs).toBe(50);
    expect(t.caseConcurrency).toBe(4);
    expect(t.path).toEqual({ planningMs: 1, approvalWaitMs: 2, queueMs: 3 });
    // The wrapped method still runs against the real port.
    expect(port.self).toEqual([port]);
  });

  it("counts every call of a tagged view under its purpose", async () => {
    const clock = manualClock();
    const meter = new RunMeter(clock.now);
    const ports = { stripe: stubPort(clock) };
    const guard = meter.providers(ports, "guard").stripe;
    const compensation = meter.providers(ports, "compensation").stripe;

    await guard?.observe({ vendor: "stripe", kind: "charge", id: "ch_1" }, {} as never);
    await guard?.query({} as never, "", {} as never);
    await compensation?.reconcile({} as never, {} as never, {} as never);

    const t = meter.timings({ planningMs: null, approvalWaitMs: null, queueMs: null }, 1);
    expect(t.calls.guard).toEqual({ calls: 2, failed: 0, ms: 20 });
    expect(t.calls.compensation).toEqual({ calls: 1, failed: 0, ms: 10 });
    expect(t.calls.read.calls).toBe(0);
    expect(t.calls.reconcile.calls).toBe(0);
  });

  it("leaves out a vendor the run has no port for and keeps optional methods absent", () => {
    const clock = manualClock();
    const meter = new RunMeter(clock.now);
    const port = stubPort(clock);
    delete port.preconditions;
    const wrapped = meter.providers({ stripe: port });
    expect(Object.keys(wrapped)).toEqual(["stripe"]);
    expect(wrapped.stripe?.preconditions).toBeUndefined();
  });

  it("counts backoff sleeps as retries, including one that throws", async () => {
    const clock = manualClock();
    const meter = new RunMeter(clock.now);
    const sleep = meter.sleep(async (ms) => clock.advance(ms));
    await sleep(250);
    await sleep(500);
    const failing = meter.sleep(async () => {
      clock.advance(5);
      throw new Error("aborted");
    });
    await expect(failing(1000)).rejects.toThrow("aborted");

    const t = meter.timings({ planningMs: null, approvalWaitMs: null, queueMs: null }, 1);
    expect(t.retries).toEqual({ count: 3, waitMs: 755 });
  });
});

describe("T3.20 path timings", () => {
  it("measures planning, approval wait and queue time from stored timestamps", () => {
    expect(
      pathTimings({
        firstReadAt: "2026-10-21T16:00:00.000Z",
        planStoredAt: "2026-10-21T16:00:42.500Z",
        grantedAt: "2026-10-21T16:05:00.000Z",
        runCreatedAt: "2026-10-21T16:05:01.000Z",
        deliveryStartedAt: "2026-10-21T16:05:01.250Z",
      }),
    ).toEqual({ planningMs: 42_500, approvalWaitMs: 257_500, queueMs: 250 });
  });

  it("reports a missing or backwards span as null, never as a negative time", () => {
    expect(
      pathTimings({
        firstReadAt: null,
        planStoredAt: "2026-10-21T16:00:00.000Z",
        grantedAt: "2026-10-21T15:00:00.000Z",
        runCreatedAt: "not a date",
        deliveryStartedAt: "2026-10-21T16:05:01.250Z",
      }),
    ).toEqual({ planningMs: null, approvalWaitMs: null, queueMs: null });
  });

  it("takes the earliest read across observations and queries", () => {
    expect(
      firstReadAt({
        observations: [{ capturedAt: "2026-10-21T16:00:05.000Z" }, { capturedAt: "bad" }],
        queryObservations: [{ capturedAt: "2026-10-21T16:00:01.000Z" }],
      }),
    ).toBe("2026-10-21T16:00:01.000Z");
    expect(firstReadAt({ observations: [], queryObservations: [] })).toBeNull();
  });
});
