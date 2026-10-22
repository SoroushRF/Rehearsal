import {
  bigserial,
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

/** One row per apply request. `state` is the only mutable column and follows `RunState`. */
export const runs = pgTable("runs", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  planId: text("plan_id").notNull(),
  revision: integer("revision").notNull(),
  planHash: text("plan_hash").notNull(),
  approvalId: text("approval_id").notNull(),
  state: text("state").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    uniqueIndex().on(t.operationKey, t.attemptNo),
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

export const runEvents = pgTable("run_events", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
  orgId: text("org_id").notNull(),
  runId: text("run_id").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});
