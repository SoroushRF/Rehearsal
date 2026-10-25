import {
  ExecutionRehearsalJob,
  ExecutionRehearsalReport,
  ExecutionRehearsalRequest,
  type ExecutionRehearsalState,
  PlanManifest,
  RehearsalStepResult,
  TERMINAL_REHEARSAL_STATES,
} from "@rehearsal/contracts";
import { planHash as computePlanHash, fingerprint, snapshotDigest } from "@rehearsal/core";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { fromDrizzle, type PgBoss } from "pg-boss";
import type { Db } from "./index";
import { REHEARSAL_QUEUE } from "./queue";
import {
  planVersions,
  rehearsalEvents,
  rehearsalReports,
  rehearsalStepResults,
  rehearsals,
} from "./schema";

/**
 * Execution rehearsal storage (T3.13, decision 0013). Separate from operational run authority: no
 * function here reads or writes runs, grants, the operational journal or the `apply` queue, and
 * none of the rows it writes parse as a run, a grant or a receipt.
 */

export interface RehearsalCommand {
  orgId: string;
  /** The verified session's user; never from the body. */
  userId: string;
  /** The caller's key for this request (e.g. an Idempotency-Key header). */
  idempotencyKey: string;
  request: ExecutionRehearsalRequest;
  now: Date;
  /** Server-chosen rehearsal ID (`ExecutionRehearsalId`: 8–32 lowercase alphanumerics). */
  newId: () => string;
}

export type RehearsalRequestResult =
  | { kind: "accepted"; rehearsalId: string; existing: boolean }
  | { kind: "not_found" }
  | { kind: "hash_mismatch"; detail: string }
  /** A plan rehearsal storage can't bind faithfully (say, more than one policy). */
  | { kind: "unsupported"; detail: string }
  | { kind: "idempotency_conflict"; rehearsalId: string };

/** What a request binds: the same key must name the same plan, hash and scenario. */
const sameRequest = (row: typeof rehearsals.$inferSelect, r: ExecutionRehearsalRequest) =>
  row.planId === r.planId &&
  row.revision === r.revision &&
  row.planHash === r.planHash &&
  row.scenarioId === r.scenario.id &&
  row.scenarioVersion === r.scenario.version;

/**
 * Store a rehearsal request and enqueue its job in one transaction, bound to the stored plan
 * exactly: the snapshot digest and policy come from the stored manifest, never from the caller. A
 * repeat with the same idempotency key returns the same rehearsal and enqueues nothing; a
 * concurrent repeat loses the unique index and returns the winner. Rehearsal admission
 * (`admitRehearsal`, T3.14) re-checks everything before anything is provisioned.
 */
export async function requestRehearsal(
  db: Db,
  boss: PgBoss,
  cmd: RehearsalCommand,
): Promise<RehearsalRequestResult> {
  const request = ExecutionRehearsalRequest.parse(cmd.request);
  const existing = async () => {
    const [row] = await db
      .select()
      .from(rehearsals)
      .where(
        and(eq(rehearsals.orgId, cmd.orgId), eq(rehearsals.idempotencyKey, cmd.idempotencyKey)),
      );
    return row;
  };
  const replay = (row: typeof rehearsals.$inferSelect): RehearsalRequestResult =>
    sameRequest(row, request)
      ? { kind: "accepted", rehearsalId: row.id, existing: true }
      : { kind: "idempotency_conflict", rehearsalId: row.id };

  const prior = await existing();
  if (prior) return replay(prior);

  const result = await db.transaction(async (tx): Promise<RehearsalRequestResult | "raced"> => {
    const [plan] = await tx
      .select()
      .from(planVersions)
      .where(
        and(
          eq(planVersions.orgId, cmd.orgId),
          eq(planVersions.planId, request.planId),
          eq(planVersions.revision, request.revision),
        ),
      );
    if (!plan) return { kind: "not_found" };
    if (plan.planHash !== request.planHash) {
      return { kind: "hash_mismatch", detail: "request hash does not match the stored revision" };
    }
    const manifest = PlanManifest.safeParse(plan.manifest);
    if (
      !manifest.success ||
      manifest.data.orgId !== cmd.orgId ||
      manifest.data.planId !== request.planId ||
      manifest.data.revision !== request.revision ||
      computePlanHash(manifest.data) !== plan.planHash
    ) {
      return { kind: "hash_mismatch", detail: "stored manifest does not match its row or hash" };
    }
    // A report binds one policy (`RehearsalPolicyRef`); binding the first of several would make its
    // staleness ignore the rest, so such a plan isn't rehearsed until the contract names them all.
    if (manifest.data.policies.length !== 1) {
      return { kind: "unsupported", detail: "a rehearsal binds exactly one policy" };
    }
    const policy = manifest.data.policies[0];
    if (!policy) return { kind: "hash_mismatch", detail: "stored manifest names no policy" };

    const id = cmd.newId();
    const job = ExecutionRehearsalJob.parse({
      world: "rehearsal",
      rehearsalId: id,
      plan: {
        orgId: cmd.orgId,
        planId: request.planId,
        revision: request.revision,
        planHash: request.planHash,
      },
      scenario: request.scenario,
      snapshot: { kind: "plan-evidence", digest: snapshotDigest(manifest.data) },
      policy: { id: policy.id, version: policy.version },
      requestedBy: cmd.userId,
      requestedAt: cmd.now.toISOString(),
    });
    const inserted = await tx
      .insert(rehearsals)
      .values({
        id,
        orgId: cmd.orgId,
        planId: request.planId,
        revision: request.revision,
        planHash: request.planHash,
        scenarioId: request.scenario.id,
        scenarioVersion: request.scenario.version,
        snapshotDigest: job.snapshot.digest,
        policyId: job.policy.id,
        policyVersion: job.policy.version,
        requestedBy: cmd.userId,
        requestedAt: cmd.now,
        idempotencyKey: cmd.idempotencyKey,
      })
      .onConflictDoNothing({ target: [rehearsals.orgId, rehearsals.idempotencyKey] })
      .returning({ id: rehearsals.id });
    if (inserted.length === 0) return "raced";
    await tx.insert(rehearsalEvents).values({
      orgId: cmd.orgId,
      rehearsalId: id,
      state: "queued",
      detail: null,
      tornDownAt: null,
      at: cmd.now,
    });
    const jobId = await boss.send(REHEARSAL_QUEUE, job, {
      db: fromDrizzle(tx, sql),
      singletonKey: `rehearsal:${id}`,
    });
    // A suppressed send would leave a rehearsal with no job; fail the transaction instead.
    if (!jobId) throw new Error(`rehearsal job for ${id} was not enqueued`);
    return { kind: "accepted", rehearsalId: id, existing: false };
  });
  if (result !== "raced") return result;
  const winner = await existing();
  if (!winner) throw new Error("idempotency key conflicted but no rehearsal holds it");
  return replay(winner);
}

/** Which state may follow which (decision 0013, §5). Terminal states are final. */
const NEXT: Record<ExecutionRehearsalState, readonly ExecutionRehearsalState[]> = {
  queued: ["provisioning", "failed", "cancelled"],
  provisioning: ["running", "failed", "cancelled"],
  running: ["verifying", "failed", "cancelled"],
  verifying: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isLegalRehearsalTransition(
  from: ExecutionRehearsalState,
  to: ExecutionRehearsalState,
): boolean {
  return NEXT[from].includes(to);
}

const isTerminal = (state: string) =>
  (TERMINAL_REHEARSAL_STATES as readonly string[]).includes(state);

export interface StoredRehearsal {
  rehearsal: typeof rehearsals.$inferSelect;
  /**
   * Every state change, oldest first. There is no lease column: a sweeper (T3.16) treats a
   * non-terminal rehearsal whose last event is older than its lease as expired, and fails it rather
   * than resuming it (decision 0013, §5).
   */
  events: (typeof rehearsalEvents.$inferSelect)[];
  state: ExecutionRehearsalState;
  tornDown: boolean;
}

/** One rehearsal and its lifecycle, only within its org. */
export async function loadRehearsal(
  db: Db,
  orgId: string,
  rehearsalId: string,
): Promise<StoredRehearsal | null> {
  const [rehearsal] = await db
    .select()
    .from(rehearsals)
    .where(and(eq(rehearsals.orgId, orgId), eq(rehearsals.id, rehearsalId)));
  if (!rehearsal) return null;
  const events = await db
    .select()
    .from(rehearsalEvents)
    .where(and(eq(rehearsalEvents.orgId, orgId), eq(rehearsalEvents.rehearsalId, rehearsalId)))
    .orderBy(asc(rehearsalEvents.seq));
  const last = events.at(-1);
  if (!last) throw new Error(`rehearsal ${rehearsalId} has no state`);
  return {
    rehearsal,
    events,
    state: last.state as ExecutionRehearsalState,
    tornDown: events.some((e) => e.tornDownAt !== null),
  };
}

/** A rehearsal's request row by ID alone, to learn which org owns it. IDs are server-chosen and unique. */
export async function rehearsalOrgOf(db: Db, rehearsalId: string): Promise<string | null> {
  const [row] = await db
    .select({ orgId: rehearsals.orgId })
    .from(rehearsals)
    .where(eq(rehearsals.id, rehearsalId));
  return row?.orgId ?? null;
}

/**
 * Every rehearsal of a plan in this org, across all its revisions, oldest first, each with its
 * lifecycle. Read-only (T2.19): the review page lists them and ties each to the revision it ran on.
 */
export async function listRehearsalsForPlan(
  db: Db,
  orgId: string,
  planId: string,
): Promise<StoredRehearsal[]> {
  const rows = await db
    .select()
    .from(rehearsals)
    .where(and(eq(rehearsals.orgId, orgId), eq(rehearsals.planId, planId)))
    .orderBy(asc(rehearsals.requestedAt), asc(rehearsals.id));
  if (rows.length === 0) return [];
  const events = await db
    .select()
    .from(rehearsalEvents)
    .where(
      and(
        eq(rehearsalEvents.orgId, orgId),
        inArray(
          rehearsalEvents.rehearsalId,
          rows.map((r) => r.id),
        ),
      ),
    )
    .orderBy(asc(rehearsalEvents.seq));
  return rows.map((rehearsal) => {
    const own = events.filter((e) => e.rehearsalId === rehearsal.id);
    const last = own.at(-1);
    if (!last) throw new Error(`rehearsal ${rehearsal.id} has no state`);
    return {
      rehearsal,
      events: own,
      state: last.state as ExecutionRehearsalState,
      tornDown: own.some((e) => e.tornDownAt !== null),
    };
  });
}

/** The stored report of one rehearsal in this org, or null if it has none yet. */
export async function loadRehearsalReport(
  db: Db,
  orgId: string,
  rehearsalId: string,
): Promise<ExecutionRehearsalReport | null> {
  const [row] = await db
    .select({ report: rehearsalReports.report })
    .from(rehearsalReports)
    .where(and(eq(rehearsalReports.orgId, orgId), eq(rehearsalReports.rehearsalId, rehearsalId)));
  return row ? ExecutionRehearsalReport.parse(row.report) : null;
}

/**
 * Append a state change if the rehearsal is in one of `from` and the move is legal. The request row
 * is locked for the change, so two deliveries of one job can't both claim it: exactly one
 * `queued → provisioning` succeeds, and a redelivery finds the rehearsal already claimed.
 */
export async function transitionRehearsal(
  db: Db,
  orgId: string,
  rehearsalId: string,
  from: readonly ExecutionRehearsalState[],
  to: ExecutionRehearsalState,
  opts: { now: Date; detail?: string | null },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: rehearsals.id })
      .from(rehearsals)
      .where(and(eq(rehearsals.orgId, orgId), eq(rehearsals.id, rehearsalId)))
      .for("update");
    if (!row) return false;
    const [last] = await tx
      .select({ state: rehearsalEvents.state })
      .from(rehearsalEvents)
      .where(and(eq(rehearsalEvents.orgId, orgId), eq(rehearsalEvents.rehearsalId, rehearsalId)))
      .orderBy(desc(rehearsalEvents.seq))
      .limit(1);
    const current = last?.state as ExecutionRehearsalState | undefined;
    if (!current || !from.includes(current) || !isLegalRehearsalTransition(current, to)) {
      return false;
    }
    await tx.insert(rehearsalEvents).values({
      orgId,
      rehearsalId,
      state: to,
      detail: opts.detail ?? null,
      tornDownAt: null,
      at: opts.now,
    });
    return true;
  });
}

/**
 * Record that the tenant was reset. Only after a terminal state, and once: teardown is idempotent,
 * so a second call returns false and writes nothing.
 */
export async function markRehearsalTornDown(
  db: Db,
  orgId: string,
  rehearsalId: string,
  now: Date,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: rehearsals.id })
      .from(rehearsals)
      .where(and(eq(rehearsals.orgId, orgId), eq(rehearsals.id, rehearsalId)))
      .for("update");
    if (!row) return false;
    const events = await tx
      .select()
      .from(rehearsalEvents)
      .where(and(eq(rehearsalEvents.orgId, orgId), eq(rehearsalEvents.rehearsalId, rehearsalId)))
      .orderBy(asc(rehearsalEvents.seq));
    const last = events.at(-1);
    if (!last || !isTerminal(last.state) || events.some((e) => e.tornDownAt !== null)) return false;
    await tx.insert(rehearsalEvents).values({
      orgId,
      rehearsalId,
      state: last.state,
      detail: "tenant reset",
      tornDownAt: now,
      at: now,
    });
    return true;
  });
}

/**
 * Store one step's result for a rehearsal of this org, once. It must name that rehearsal, its plan
 * hash and an action of its stored plan, carry an operation key namespaced to it, and arrive while
 * the rehearsal is running or verifying. A repeat of the identical result is accepted and writes
 * nothing; a different result for a step that already has one is refused, so a redelivered or
 * stale worker can't fork the evidence a report is built from.
 */
export async function recordRehearsalStepResult(
  db: Db,
  orgId: string,
  input: RehearsalStepResult,
  id: string,
): Promise<void> {
  const result = RehearsalStepResult.parse(input);
  if (!result.operationKey.startsWith(`rh_${result.rehearsalId}_`)) {
    throw new Error("step result's operation key is not namespaced to its rehearsal");
  }
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(rehearsals)
      .where(and(eq(rehearsals.orgId, orgId), eq(rehearsals.id, result.rehearsalId)))
      .for("update");
    if (!row) throw new Error(`no rehearsal ${result.rehearsalId} in this org`);
    if (result.planHash !== row.planHash) {
      throw new Error("step result names another plan hash than its rehearsal");
    }
    const [last] = await tx
      .select({ state: rehearsalEvents.state })
      .from(rehearsalEvents)
      .where(and(eq(rehearsalEvents.orgId, orgId), eq(rehearsalEvents.rehearsalId, row.id)))
      .orderBy(desc(rehearsalEvents.seq))
      .limit(1);
    if (last?.state !== "running" && last?.state !== "verifying") {
      throw new Error(`rehearsal ${row.id} is ${last?.state}; it takes no step results`);
    }
    const [plan] = await tx
      .select({ manifest: planVersions.manifest })
      .from(planVersions)
      .where(
        and(
          eq(planVersions.orgId, orgId),
          eq(planVersions.planId, row.planId),
          eq(planVersions.revision, row.revision),
        ),
      );
    const actions = (plan?.manifest as { actions?: { id?: unknown }[] } | undefined)?.actions ?? [];
    if (!actions.some((a) => a.id === result.actionId)) {
      throw new Error(`${result.actionId} is not a step of the rehearsed plan`);
    }
    const inserted = await tx
      .insert(rehearsalStepResults)
      .values({
        id,
        orgId,
        rehearsalId: result.rehearsalId,
        actionId: result.actionId,
        result,
        recordedAt: new Date(result.recordedAt),
      })
      .onConflictDoNothing({
        target: [
          rehearsalStepResults.orgId,
          rehearsalStepResults.rehearsalId,
          rehearsalStepResults.actionId,
        ],
      })
      .returning({ id: rehearsalStepResults.id });
    if (inserted.length > 0) return;
    const [existing] = await tx
      .select({ result: rehearsalStepResults.result })
      .from(rehearsalStepResults)
      .where(
        and(
          eq(rehearsalStepResults.orgId, orgId),
          eq(rehearsalStepResults.rehearsalId, result.rehearsalId),
          eq(rehearsalStepResults.actionId, result.actionId),
        ),
      );
    if (!existing || fingerprint(existing.result) !== fingerprint(result)) {
      throw new Error(`${result.actionId} already has a different result in this rehearsal`);
    }
  });
}

export async function listRehearsalStepResults(
  db: Db,
  orgId: string,
  rehearsalId: string,
): Promise<RehearsalStepResult[]> {
  const rows = await db
    .select({ result: rehearsalStepResults.result })
    .from(rehearsalStepResults)
    .where(
      and(eq(rehearsalStepResults.orgId, orgId), eq(rehearsalStepResults.rehearsalId, rehearsalId)),
    )
    .orderBy(asc(rehearsalStepResults.recordedAt), asc(rehearsalStepResults.id));
  return rows.map((r) => RehearsalStepResult.parse(r.result));
}

/**
 * Store the immutable report once the rehearsal has ended. It must match the rehearsal it names
 * (org, plan, hash, scenario, snapshot, policy and the terminal state reached). A second report for
 * the same rehearsal is refused; the first is kept.
 */
export async function saveRehearsalReport(
  db: Db,
  orgId: string,
  input: ExecutionRehearsalReport,
  now: Date,
): Promise<void> {
  const report = ExecutionRehearsalReport.parse(input);
  const stored = await loadRehearsal(db, orgId, report.rehearsalId);
  if (!stored) throw new Error(`no rehearsal ${report.rehearsalId} in this org`);
  const r = stored.rehearsal;
  if (
    report.plan.orgId !== orgId ||
    report.plan.planId !== r.planId ||
    report.plan.revision !== r.revision ||
    report.plan.planHash !== r.planHash ||
    report.scenario.id !== r.scenarioId ||
    report.scenario.version !== r.scenarioVersion ||
    report.snapshot.digest !== r.snapshotDigest ||
    report.policy.id !== r.policyId ||
    report.policy.version !== r.policyVersion
  ) {
    throw new Error("report doesn't match the rehearsal it names");
  }
  if (!isTerminal(stored.state) || report.state !== stored.state) {
    throw new Error(`report says ${report.state}, the rehearsal is ${stored.state}`);
  }
  const inserted = await db
    .insert(rehearsalReports)
    .values({
      rehearsalId: report.rehearsalId,
      orgId,
      planId: r.planId,
      planHash: r.planHash,
      report,
      recordedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: rehearsalReports.rehearsalId });
  if (inserted.length === 0)
    throw new Error(`rehearsal ${report.rehearsalId} already has a report`);
}

/** Every report for a plan in this org, newest first. Old ones are kept, never replaced. */
export async function rehearsalReportsFor(
  db: Db,
  orgId: string,
  planId: string,
): Promise<ExecutionRehearsalReport[]> {
  const rows = await db
    .select({ report: rehearsalReports.report })
    .from(rehearsalReports)
    .where(and(eq(rehearsalReports.orgId, orgId), eq(rehearsalReports.planId, planId)))
    .orderBy(desc(rehearsalReports.recordedAt));
  return rows.map((r) => ExecutionRehearsalReport.parse(r.report));
}
