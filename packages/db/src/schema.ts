import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Starting schema (owner: B). Every row is org-scoped. Plans and receipts are append-only;
 * corrections are new rows. pg-boss creates its own tables in a separate schema.
 */

export const planVersions = pgTable(
  "plan_versions",
  {
    orgId: text("org_id").notNull(),
    planId: text("plan_id").notNull(),
    revision: integer("revision").notNull(),
    planHash: text("plan_hash").notNull(),
    manifest: jsonb("manifest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.planId, t.revision] }), uniqueIndex().on(t.planHash)],
);

/**
 * A run applies one approved plan hash. `state` is the only mutable column and follows `RunState`.
 * At most one run per hash may be active (`approved` or `applying`); a held, partial or failed run
 * can be followed by a new one, which resumes from the journal instead of re-sending.
 */
export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    planId: text("plan_id").notNull(),
    revision: integer("revision").notNull(),
    planHash: text("plan_hash").notNull(),
    approvalId: text("approval_id").notNull(),
    requestedBy: text("requested_by").notNull(),
    state: text("state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.orgId, t.planHash).where(sql`${t.state} in ('approved', 'applying')`)],
);

export const approvalGrants = pgTable("approval_grants", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  planId: text("plan_id").notNull(),
  revision: integer("revision").notNull(),
  planHash: text("plan_hash").notNull(),
  actorUserId: text("actor_user_id").notNull(),
  actorSessionId: text("actor_session_id").notNull(),
  roles: jsonb("roles").$type<string[]>().notNull(),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  /**
   * The policy files the plan was checked against when it was approved, verbatim, so an old run
   * shows the rules it was approved under even after the policy file changes. Null on a grant
   * made before this column existed.
   */
  policies: jsonb("policies").$type<{ id: string; version: number; contents: unknown }[]>(),
});

export const stepAttempts = pgTable(
  "step_attempts",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    planHash: text("plan_hash").notNull(),
    actionId: text("action_id").notNull(),
    operationKey: text("operation_key").notNull(),
    attemptNo: integer("attempt_no").notNull(),
    state: text("state").notNull(),
    request: jsonb("request").notNull(),
    providerStatus: integer("provider_status"),
    error: text("error"),
    preparedAt: timestamp("prepared_at", { withTimezone: true }).notNull(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex().on(t.orgId, t.operationKey, t.attemptNo),
    index().on(t.orgId, t.planHash, t.actionId),
  ],
);

export const stepReceipts = pgTable("step_receipts", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  planHash: text("plan_hash").notNull(),
  actionId: text("action_id").notNull(),
  receipt: jsonb("receipt").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
});

export const objectBindings = pgTable(
  "object_bindings",
  {
    orgId: text("org_id").notNull(),
    planHash: text("plan_hash").notNull(),
    stepId: text("step_id").notNull(),
    path: text("path").notNull(),
    value: jsonb("value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.planHash, t.stepId, t.path] })],
);

export const runEvents = pgTable(
  "run_events",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    orgId: text("org_id").notNull(),
    runId: text("run_id").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  // The reaper counts a run's events by type on every sweep; the timeline reads by run.
  (t) => [index().on(t.orgId, t.runId, t.type)],
);

/**
 * The precedent registry, as append-only events (decision 0012). `approved` carries the full
 * record; `activated` is written once Agent Memory has stored and read it back; `withdrawn` ends a
 * precedent. Which version is active, and each area's epoch, are derived from these rows, never
 * stored, so there is nothing to edit.
 */
export const precedentEvents = pgTable(
  "precedent_events",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    orgId: text("org_id").notNull(),
    precedentId: text("precedent_id").notNull(),
    version: integer("version").notNull(),
    appliesTo: text("applies_to").notNull(),
    kind: text("kind").$type<"approved" | "activated" | "withdrawn">().notNull(),
    digest: text("digest").notNull(),
    /** The approved record, verbatim. Only on `approved`. */
    record: jsonb("record"),
    actorUserId: text("actor_user_id"),
    /** The completed run this was promoted from. Only on `approved`. */
    sourceRunId: text("source_run_id"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex().on(t.orgId, t.precedentId, t.version, t.kind),
    index().on(t.orgId, t.appliesTo),
  ],
);

/**
 * Execution rehearsals (T3.13, decision 0013). Their own tables: the operational journal, admission
 * and approval lookup never read these, and nothing here is a run, a grant or a receipt. Every row
 * is org-scoped and append-only; a rehearsal's state is its last event.
 */
export const rehearsals = pgTable(
  "rehearsals",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    planId: text("plan_id").notNull(),
    revision: integer("revision").notNull(),
    planHash: text("plan_hash").notNull(),
    scenarioId: text("scenario_id").notNull(),
    scenarioVersion: integer("scenario_version").notNull(),
    snapshotDigest: text("snapshot_digest").notNull(),
    policyId: text("policy_id").notNull(),
    policyVersion: integer("policy_version").notNull(),
    requestedBy: text("requested_by").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    /** The caller's key for this request: a repeat returns the same rehearsal. */
    idempotencyKey: text("idempotency_key").notNull(),
  },
  (t) => [uniqueIndex().on(t.orgId, t.idempotencyKey), index().on(t.orgId, t.planId)],
);

export const rehearsalEvents = pgTable(
  "rehearsal_events",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    orgId: text("org_id").notNull(),
    rehearsalId: text("rehearsal_id").notNull(),
    state: text("state").notNull(),
    detail: text("detail"),
    tornDownAt: timestamp("torn_down_at", { withTimezone: true }),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [index().on(t.orgId, t.rehearsalId)],
);

/** The rehearsal's own journal: same shape as `step_attempts`, keys namespaced `rh_<id>_`. */
export const rehearsalAttempts = pgTable(
  "rehearsal_attempts",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    rehearsalId: text("rehearsal_id").notNull(),
    planHash: text("plan_hash").notNull(),
    actionId: text("action_id").notNull(),
    operationKey: text("operation_key").notNull(),
    attemptNo: integer("attempt_no").notNull(),
    state: text("state").notNull(),
    request: jsonb("request").notNull(),
    providerStatus: integer("provider_status"),
    error: text("error"),
    preparedAt: timestamp("prepared_at", { withTimezone: true }).notNull(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex().on(t.orgId, t.operationKey, t.attemptNo),
    index().on(t.orgId, t.rehearsalId),
    check(
      "rehearsal_attempts_key_namespaced",
      sql`starts_with(${t.operationKey}, 'rh_' || ${t.rehearsalId} || '_')`,
    ),
  ],
);

export const rehearsalBindings = pgTable(
  "rehearsal_bindings",
  {
    orgId: text("org_id").notNull(),
    rehearsalId: text("rehearsal_id").notNull(),
    stepId: text("step_id").notNull(),
    path: text("path").notNull(),
    value: jsonb("value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.rehearsalId, t.stepId, t.path] })],
);

/** One `RehearsalStepResult` per settled step, as recorded. Never an operational receipt. */
export const rehearsalStepResults = pgTable(
  "rehearsal_step_results",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    rehearsalId: text("rehearsal_id").notNull(),
    actionId: text("action_id").notNull(),
    result: jsonb("result").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (t) => [index().on(t.orgId, t.rehearsalId)],
);

/** The immutable report, one per rehearsal. Kept for history: superseded reports are never deleted. */
export const rehearsalReports = pgTable(
  "rehearsal_reports",
  {
    rehearsalId: text("rehearsal_id").primaryKey(),
    orgId: text("org_id").notNull(),
    planId: text("plan_id").notNull(),
    planHash: text("plan_hash").notNull(),
    report: jsonb("report").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (t) => [index().on(t.orgId, t.planId)],
);
