import type {
  ApprovalGrant,
  Attempt,
  AttemptState,
  ObjectBinding,
  Receipt,
  RunEvent,
} from "@rehearsal/contracts";
import type { ApplyStore, JournalPort, StoredRun } from "@rehearsal/core";

/** Same transition table as the Postgres journal, so fakes can't allow what production refuses. */
const LEGAL: Record<AttemptState, readonly AttemptState[]> = {
  prepared: ["dispatched"],
  dispatched: ["confirmed", "rejected", "unknown_outcome"],
  unknown_outcome: ["reconciled"],
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

  async recordReceipt(receipt: Receipt): Promise<void> {
    this.receipts.push(structuredClone(receipt));
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

  async appendEvent(runId: string, type: string, payload: unknown): Promise<RunEvent> {
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
}
