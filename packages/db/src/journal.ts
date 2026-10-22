import type { Attempt, AttemptState, ObjectBinding, Receipt, RunEvent } from "@rehearsal/contracts";
import type { JournalPort, SettleStep } from "@rehearsal/core";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "./index";
import { objectBindings, runEvents, stepAttempts, stepReceipts } from "./schema";

/** `unknown_outcome` leaves only through reconciliation, which reads the provider and never re-sends. */
const LEGAL: Record<AttemptState, readonly AttemptState[]> = {
  prepared: ["dispatched"],
  dispatched: ["confirmed", "rejected", "unknown_outcome"],
  unknown_outcome: ["reconciled"],
  confirmed: [],
  rejected: [],
  reconciled: [],
};

export function isLegalTransition(from: AttemptState, to: AttemptState): boolean {
  return LEGAL[from].includes(to);
}

export class JournalConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JournalConflictError";
  }
}

type AttemptRow = typeof stepAttempts.$inferSelect;

function toAttempt(row: AttemptRow): Attempt {
  return {
    id: row.id,
    actionId: row.actionId,
    planHash: row.planHash,
    operationKey: row.operationKey,
    attemptNo: row.attemptNo,
    state: row.state as AttemptState,
    request: row.request as Attempt["request"],
    providerStatus: row.providerStatus,
    error: row.error,
    preparedAt: row.preparedAt.toISOString(),
    dispatchedAt: row.dispatchedAt?.toISOString() ?? null,
    settledAt: row.settledAt?.toISOString() ?? null,
  };
}

const toDate = (iso: string | null | undefined) => (iso ? new Date(iso) : undefined);

/**
 * Postgres journal for one organization. Every query is scoped to `orgId`, and attempts move
 * only through compare-and-set updates so two workers can never both advance the same attempt.
 */
export class PgJournal implements JournalPort {
  constructor(
    private readonly db: Db,
    private readonly orgId: string,
  ) {}

  async prepareAttempt(attempt: Attempt): Promise<void> {
    if (attempt.state !== "prepared") {
      throw new JournalConflictError(`attempt ${attempt.id} must be inserted as prepared`);
    }
    await this.db.insert(stepAttempts).values({
      id: attempt.id,
      orgId: this.orgId,
      planHash: attempt.planHash,
      actionId: attempt.actionId,
      operationKey: attempt.operationKey,
      attemptNo: attempt.attemptNo,
      state: attempt.state,
      request: attempt.request,
      providerStatus: attempt.providerStatus,
      error: attempt.error,
      preparedAt: new Date(attempt.preparedAt),
      dispatchedAt: toDate(attempt.dispatchedAt),
      settledAt: toDate(attempt.settledAt),
    });
  }

  async transition(
    attemptId: string,
    from: AttemptState,
    to: AttemptState,
    patch: Partial<Pick<Attempt, "providerStatus" | "error" | "dispatchedAt" | "settledAt">> = {},
  ): Promise<Attempt> {
    if (!isLegalTransition(from, to)) {
      throw new JournalConflictError(`illegal attempt transition ${from} -> ${to}`);
    }
    const [row] = await this.db
      .update(stepAttempts)
      .set({
        state: to,
        ...(patch.providerStatus !== undefined && { providerStatus: patch.providerStatus }),
        ...(patch.error !== undefined && { error: patch.error }),
        ...(patch.dispatchedAt && { dispatchedAt: new Date(patch.dispatchedAt) }),
        ...(patch.settledAt && { settledAt: new Date(patch.settledAt) }),
      })
      .where(
        and(
          eq(stepAttempts.orgId, this.orgId),
          eq(stepAttempts.id, attemptId),
          eq(stepAttempts.state, from),
        ),
      )
      .returning();
    if (!row) {
      throw new JournalConflictError(`attempt ${attemptId} is not in state ${from}`);
    }
    return toAttempt(row);
  }

  async attemptsFor(planHash: string, actionId: string): Promise<Attempt[]> {
    const rows = await this.db
      .select()
      .from(stepAttempts)
      .where(
        and(
          eq(stepAttempts.orgId, this.orgId),
          eq(stepAttempts.planHash, planHash),
          eq(stepAttempts.actionId, actionId),
        ),
      )
      .orderBy(asc(stepAttempts.attemptNo));
    return rows.map(toAttempt);
  }

  async attemptsForKey(operationKey: string): Promise<Attempt[]> {
    const rows = await this.db
      .select()
      .from(stepAttempts)
      .where(and(eq(stepAttempts.orgId, this.orgId), eq(stepAttempts.operationKey, operationKey)))
      .orderBy(asc(stepAttempts.attemptNo));
    return rows.map(toAttempt);
  }

  async settle(step: SettleStep): Promise<void> {
    await this.db.transaction(async (tx) => {
      // A transaction exposes the same query API; reuse this journal's methods inside it.
      const inTx = new PgJournal(tx as unknown as Db, this.orgId);
      if (step.transition) {
        const t = step.transition;
        await inTx.transition(t.attemptId, t.from, t.to, t.patch);
      }
      for (const binding of step.bindings) await inTx.bind(binding);
      await inTx.recordReceipt(step.receipt);
    });
  }

  async recordReceipt(receipt: Receipt): Promise<void> {
    await this.db.insert(stepReceipts).values({
      id: receipt.id,
      orgId: this.orgId,
      planHash: receipt.planHash,
      actionId: receipt.actionId,
      receipt,
      recordedAt: new Date(receipt.recordedAt),
    });
  }

  async receiptsFor(planHash: string): Promise<Receipt[]> {
    const rows = await this.db
      .select({ receipt: stepReceipts.receipt })
      .from(stepReceipts)
      .where(and(eq(stepReceipts.orgId, this.orgId), eq(stepReceipts.planHash, planHash)))
      .orderBy(asc(stepReceipts.recordedAt), asc(stepReceipts.id));
    return rows.map((r) => r.receipt as Receipt);
  }

  async bind(binding: ObjectBinding): Promise<void> {
    const { stepId, path } = binding.ref;
    const inserted = await this.db
      .insert(objectBindings)
      .values({
        orgId: this.orgId,
        planHash: binding.planHash,
        stepId,
        path,
        value: binding.value,
      })
      .onConflictDoNothing()
      .returning({ stepId: objectBindings.stepId });
    if (inserted.length > 0) return;
    // A binding is written once. Re-binding the same value is a no-op; a different value is a bug.
    const [existing] = await this.db
      .select({ value: objectBindings.value })
      .from(objectBindings)
      .where(
        and(
          eq(objectBindings.orgId, this.orgId),
          eq(objectBindings.planHash, binding.planHash),
          eq(objectBindings.stepId, stepId),
          eq(objectBindings.path, path),
        ),
      );
    if (existing?.value !== binding.value) {
      throw new JournalConflictError(`binding ${stepId}:${path} already holds a different value`);
    }
  }

  async bindings(planHash: string): Promise<ObjectBinding[]> {
    const rows = await this.db
      .select()
      .from(objectBindings)
      .where(and(eq(objectBindings.orgId, this.orgId), eq(objectBindings.planHash, planHash)));
    return rows.map((r) => ({
      planHash: r.planHash,
      ref: { $ref: "result", stepId: r.stepId, path: r.path as ObjectBinding["ref"]["path"] },
      value: r.value as string | number,
    }));
  }

  /**
   * `seq` is a global insertion order, not a commit order: with concurrent writers a reader that
   * tails `seq > lastSeen` can miss a row. One executor writes per run, so per-run order holds.
   * A missing payload is stored as `{}` (the column is NOT NULL); the stored value is returned.
   */
  async appendEvent(runId: string, type: string, payload: unknown): Promise<RunEvent> {
    const [row] = await this.db
      .insert(runEvents)
      .values({ orgId: this.orgId, runId, type, payload: payload ?? {} })
      .returning();
    if (!row) throw new Error("run event insert returned no row");
    return {
      seq: row.seq,
      runId: row.runId,
      type: row.type,
      at: row.at.toISOString(),
      payload: row.payload,
    };
  }
}
