import type {
  ApprovalGrant,
  Attempt,
  AttemptState,
  ObjectBinding,
  Receipt,
  RunEvent,
} from "@rehearsal/contracts";
import type { ApplyStore, JournalPort, SettleStep, StoredRun } from "@rehearsal/core";

/** Same transition table as the Postgres journal, so fakes can't allow what production refuses. */
const LEGAL: Record<AttemptState, readonly AttemptState[]> = {
  prepared: ["dispatched"],
  dispatched: ["confirmed", "rejected", "unknown_outcome"],
  unknown_outcome: ["reconciled", "rejected"],
  confirmed: [],
  rejected: [],
  reconciled: [],
};

/** In-memory JournalPort for executor tests. Survives a simulated restart if you keep the object. */
export class MemoryJournal implements JournalPort {
  readonly attempts = new Map<string, Attempt>();
  readonly receipts: Receipt[] = [];
  readonly events: RunEvent[] = [];
  readonly #bindings = new Map<string, ObjectBinding>();

  async prepareAttempt(attempt: Attempt): Promise<void> {
    if (attempt.state !== "prepared") throw new Error("attempt must be inserted as prepared");
    if (this.attempts.has(attempt.id)) throw new Error(`duplicate attempt ${attempt.id}`);
    for (const a of this.attempts.values()) {
      if (a.operationKey === attempt.operationKey && a.attemptNo === attempt.attemptNo) {
        throw new Error("duplicate operation key and attempt number");
      }
    }
    this.attempts.set(attempt.id, structuredClone(attempt));
  }

  async transition(
    attemptId: string,
    from: AttemptState,
    to: AttemptState,
    patch: Partial<Pick<Attempt, "providerStatus" | "error" | "dispatchedAt" | "settledAt">> = {},
  ): Promise<Attempt> {
    if (!LEGAL[from].includes(to)) throw new Error(`illegal attempt transition ${from} -> ${to}`);
    await this.beforeTransition?.(attemptId, to);
    if (this.failNextTransitionTo === to) {
      this.failNextTransitionTo = null;
      throw new Error(`crash before ${to} (injected)`);
    }
    const current = this.attempts.get(attemptId);
    if (current?.state !== from) throw new Error(`attempt ${attemptId} is not in state ${from}`);
    const next = { ...current, ...patch, state: to };
    this.attempts.set(attemptId, next);
    return structuredClone(next);
  }

  async attemptsFor(planHash: string, actionId: string): Promise<Attempt[]> {
    return [...this.attempts.values()]
      .filter((a) => a.planHash === planHash && a.actionId === actionId)
      .sort((a, b) => a.attemptNo - b.attemptNo)
      .map((a) => structuredClone(a));
  }

  async attemptsForKey(operationKey: string): Promise<Attempt[]> {
    return [...this.attempts.values()]
      .filter((a) => a.operationKey === operationKey)
      .sort((a, b) => a.attemptNo - b.attemptNo)
      .map((a) => structuredClone(a));
  }

  /** Set to make the next `settle` throw before writing anything (a crash mid-settle). */
  failNextSettle = false;
  /** Set to make the next transition into this state throw (a crash just before it). */
  failNextTransitionTo: AttemptState | null = null;
  /** Set to make the next event of this type fail to write. */
  failNextEvent: string | null = null;
  /** Awaited before every transition, so a test can pause a run at an exact point. */
  beforeTransition: ((attemptId: string, to: AttemptState) => Promise<void>) | null = null;

  async settle(step: SettleStep): Promise<void> {
    if (this.failNextSettle) {
      this.failNextSettle = false;
      throw new Error("journal unavailable (injected)");
    }
    // Validate everything first so the write is all-or-nothing, like the Postgres transaction.
    const all = [...(step.transitions ?? []), ...(step.transition ? [step.transition] : [])];
    const states = new Map<string, AttemptState | undefined>();
    for (const t of all) {
      if (!LEGAL[t.from].includes(t.to))
        throw new Error(`illegal attempt transition ${t.from} -> ${t.to}`);
      const now = states.has(t.attemptId)
        ? states.get(t.attemptId)
        : this.attempts.get(t.attemptId)?.state;
      if (now !== t.from) throw new Error(`attempt ${t.attemptId} is not in state ${t.from}`);
      states.set(t.attemptId, t.to);
    }
    for (const b of step.bindings) {
      const existing = this.#bindings.get(`${b.planHash}:${b.ref.stepId}:${b.ref.path}`);
      if (existing && existing.value !== b.value)
        throw new Error("binding already holds a different value");
    }
    for (const t of all) await this.transition(t.attemptId, t.from, t.to, t.patch);
    for (const b of step.bindings) await this.bind(b);
    await this.recordReceipt(step.receipt);
  }

  async recordReceipt(receipt: Receipt): Promise<void> {
    this.receipts.push(structuredClone(receipt));
  }

  async receiptsFor(planHash: string): Promise<Receipt[]> {
    return this.receipts.filter((r) => r.planHash === planHash).map((r) => structuredClone(r));
  }

  async bind(binding: ObjectBinding): Promise<void> {
    const key = `${binding.planHash}:${binding.ref.stepId}:${binding.ref.path}`;
    const existing = this.#bindings.get(key);
    if (existing && existing.value !== binding.value) {
      throw new Error(`binding ${key} already holds a different value`);
    }
    this.#bindings.set(key, structuredClone(binding));
  }

  async bindings(planHash: string): Promise<ObjectBinding[]> {
    return [...this.#bindings.values()].filter((b) => b.planHash === planHash);
  }

  async runReceipts(runId: string): Promise<Receipt[]> {
    const own = this.events.filter((e) => e.runId === runId);
    const lastFinished = own.findLastIndex((e) => e.type === "run.finished");
    return own
      .slice(lastFinished + 1)
      .filter((e) => e.type === "step.receipt")
      .map((e) => e.payload as Receipt);
  }

  async appendEvent(runId: string, type: string, payload: unknown): Promise<RunEvent> {
    if (this.failNextEvent === type) {
      this.failNextEvent = null;
      throw new Error("event write failed (injected)");
    }
    const event = {
      seq: this.events.length + 1,
      runId,
      type,
      at: new Date().toISOString(),
      payload,
    };
    this.events.push(event);
    return event;
  }
}

/** In-memory ApplyStore: one run, its plan revision and its grant. */
export class MemoryApplyStore implements ApplyStore {
  readonly runs = new Map<string, StoredRun>();
  readonly plans = new Map<string, { planHash: string; manifest: unknown }>();
  readonly grants = new Map<string, ApprovalGrant>();

  async loadRun(_orgId: string, runId: string) {
    return this.runs.get(runId) ?? null;
  }
  async loadPlan(_orgId: string, planId: string, revision: number) {
    return this.plans.get(`${planId}@${revision}`) ?? null;
  }
  async loadGrant(_orgId: string, approvalId: string) {
    return this.grants.get(approvalId) ?? null;
  }
  /** Run IDs a test has cancelled. */
  readonly cancelled = new Set<string>();
  async runCancelled(_orgId: string, runId: string) {
    return this.cancelled.has(runId);
  }

  readonly #locks = new Set<string>();
  async lockPlan(orgId: string, planId: string) {
    const key = `${orgId}:${planId}`;
    if (this.#locks.has(key)) return null;
    this.#locks.add(key);
    return async () => {
      this.#locks.delete(key);
    };
  }
}
