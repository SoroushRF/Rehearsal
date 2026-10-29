import type { Vendor } from "@rehearsal/contracts";
import type { ProviderPort } from "./ports";

/**
 * T3.20: where a run's time goes, end to end. Diagnostics only: nothing here admits, holds or
 * retries a step, and a run's outcome never depends on it.
 *
 * Provider calls are counted by why they were made. The executor's own calls are tagged by method
 * (a dispatch is a write, a reconcile is a reconcile). The guard and the compensator each get
 * their own tagged view of the ports, so their reads are told apart exactly, also when several
 * cases run at once. One call is one port method call: a reconcile or a paged query may make more
 * than one HTTP request inside it.
 */

export const CALL_PURPOSES = [
  "guard",
  "precondition",
  "write",
  "reconcile",
  "read",
  "compensation",
] as const;
export type CallPurpose = (typeof CALL_PURPOSES)[number];

export interface PurposeTotals {
  calls: number;
  /** Calls that threw (a transport error, a 5xx the adapter raised). They are timed too. */
  failed: number;
  /** Summed time inside the calls. With several cases at once this can exceed the run's. */
  ms: number;
}

/** From the stored record: plan, grant and run timestamps. Null when one is missing. */
export interface PathTimings {
  /** The plan's first recorded read to the plan being stored. */
  planningMs: number | null;
  /** The plan being stored to the approval that this run applies. */
  approvalWaitMs: number | null;
  /** The run being created to this delivery starting. A retried delivery counts from creation. */
  queueMs: number | null;
}

export interface RunTimings {
  version: 1;
  path: PathTimings;
  /** This delivery of the run job: admission, every step, compensation and the receipts. */
  executeMs: number;
  calls: Record<CallPurpose, PurposeTotals>;
  /** Backoff waits before a resend of the same bytes (429, 5xx). */
  retries: { count: number; waitMs: number };
  caseConcurrency: number;
}

export interface PathTimes {
  /** Earliest `capturedAt` among the plan's observations and queries. */
  firstReadAt: string | null;
  planStoredAt: string | null;
  grantedAt: string | null;
  runCreatedAt: string | null;
  deliveryStartedAt: string;
}

const span = (from: string | null, to: string | null): number | null => {
  if (from === null || to === null) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : null;
};

export function pathTimings(t: PathTimes): PathTimings {
  return {
    planningMs: span(t.firstReadAt, t.planStoredAt),
    approvalWaitMs: span(t.planStoredAt, t.grantedAt),
    queueMs: span(t.runCreatedAt, t.deliveryStartedAt),
  };
}

/** The earliest read a plan records, or null for a plan with none. */
export function firstReadAt(manifest: {
  observations: readonly { capturedAt: string }[];
  queryObservations: readonly { capturedAt: string }[];
}): string | null {
  const times = [...manifest.observations, ...manifest.queryObservations]
    .map((o) => o.capturedAt)
    .filter((at) => Number.isFinite(Date.parse(at)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return times[0] ?? null;
}

type Ports = Partial<Record<Vendor, ProviderPort>>;

const BY_METHOD = {
  observe: "read",
  query: "read",
  preconditions: "precondition",
  dispatch: "write",
  reconcile: "reconcile",
} as const satisfies Record<string, CallPurpose>;

export class RunMeter {
  readonly #now: () => number;
  readonly #started: number;
  readonly #calls = Object.fromEntries(
    CALL_PURPOSES.map((p) => [p, { calls: 0, failed: 0, ms: 0 }]),
  ) as Record<CallPurpose, PurposeTotals>;
  readonly #retries = { count: 0, waitMs: 0 };

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
    this.#started = now();
  }

  async track<T>(purpose: CallPurpose, call: () => Promise<T>): Promise<T> {
    const totals = this.#calls[purpose];
    const t0 = this.#now();
    totals.calls++;
    try {
      return await call();
    } catch (err) {
      totals.failed++;
      throw err;
    } finally {
      totals.ms += this.#now() - t0;
    }
  }

  /** The executor's backoff sleep, counted as retry waits. */
  sleep(inner: (ms: number) => Promise<void>): (ms: number) => Promise<void> {
    return async (ms) => {
      this.#retries.count++;
      const t0 = this.#now();
      try {
        await inner(ms);
      } finally {
        this.#retries.waitMs += this.#now() - t0;
      }
    };
  }

  /**
   * The same ports, counted. With a purpose every call counts under it (the guard's and the
   * compensator's ports); without one, each call counts by its method. Pure methods (`prepare`,
   * `preconditionsOf`, `idempotentResend`) make no call and pass straight through.
   */
  providers(ports: Ports, purpose?: CallPurpose): Ports {
    return Object.fromEntries(
      Object.entries(ports).map(([vendor, port]) => [
        vendor,
        port && this.#port(port, (method) => purpose ?? BY_METHOD[method]),
      ]),
    ) as Ports;
  }

  #port(port: ProviderPort, purposeOf: (method: keyof typeof BY_METHOD) => CallPurpose) {
    const counted =
      <A extends unknown[], R>(method: keyof typeof BY_METHOD, f: (...args: A) => Promise<R>) =>
      (...args: A) =>
        this.track(purposeOf(method), () => f.apply(port, args));
    const wrapped: ProviderPort = {
      vendor: port.vendor,
      observe: counted("observe", port.observe),
      query: counted("query", port.query),
      prepare: (...args) => port.prepare(...args),
      dispatch: counted("dispatch", port.dispatch),
      reconcile: counted("reconcile", port.reconcile),
    };
    if (port.preconditions) wrapped.preconditions = counted("preconditions", port.preconditions);
    if (port.preconditionsOf) {
      const of = port.preconditionsOf;
      wrapped.preconditionsOf = (request) => of.call(port, request);
    }
    if (port.idempotentResend) {
      const resend = port.idempotentResend;
      wrapped.idempotentResend = (action) => resend.call(port, action);
    }
    return wrapped;
  }

  timings(path: PathTimings, caseConcurrency: number): RunTimings {
    const round = (ms: number) => Math.round(ms);
    return {
      version: 1,
      path,
      executeMs: round(this.#now() - this.#started),
      calls: Object.fromEntries(
        CALL_PURPOSES.map((p) => [p, { ...this.#calls[p], ms: round(this.#calls[p].ms) }]),
      ) as Record<CallPurpose, PurposeTotals>,
      retries: { count: this.#retries.count, waitMs: round(this.#retries.waitMs) },
      caseConcurrency,
    };
  }
}
