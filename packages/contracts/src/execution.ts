import { z } from "zod";
import { ProtectionLevel } from "./actions";
import { EntityRef, ResultRef, Sha256Hex, Timestamp } from "./common";

export const RunState = z.enum([
  "planning",
  "review_ready",
  "approved",
  "applying",
  "completed",
  "partial",
  "held",
  "failed",
  "cancelled",
]);
export type RunState = z.infer<typeof RunState>;

/**
 * prepared → dispatched → confirmed | rejected | unknown_outcome.
 * unknown_outcome → reconciled (a read found the effect) | rejected (a read showed it never happened).
 */
export const AttemptState = z.enum([
  "prepared",
  "dispatched",
  "confirmed",
  "rejected",
  "unknown_outcome",
  "reconciled",
]);
export type AttemptState = z.infer<typeof AttemptState>;

/** Persisted BEFORE dispatch, with the exact bytes, so a retry resends the identical request. */
export const Attempt = z.object({
  id: z.string().min(1),
  actionId: z.string().min(1),
  planHash: Sha256Hex,
  /** Stable per org + target + action + obligation. Doubles as the provider idempotency key. */
  operationKey: z.string().min(1),
  attemptNo: z.int().positive(),
  state: AttemptState,
  request: z.object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().min(1),
    encoding: z.enum(["form", "json"]),
    body: z.string(),
    bodySha256: Sha256Hex,
  }),
  providerStatus: z.int().nullable(),
  error: z.string().nullable(),
  preparedAt: Timestamp,
  dispatchedAt: Timestamp.nullable(),
  settledAt: Timestamp.nullable(),
});
export type Attempt = z.infer<typeof Attempt>;

export const HoldReason = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approval_invalid"), detail: z.string() }),
  z.object({ kind: z.literal("predecessor_not_confirmed"), stepId: z.string() }),
  z.object({
    kind: z.literal("row_changed"),
    observationId: z.string(),
    fields: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("query_membership_changed"),
    queryObservationId: z.string(),
    added: z.array(z.string()),
    removed: z.array(z.string()),
  }),
  z.object({ kind: z.literal("policy_violation"), rule: z.string(), detail: z.string() }),
  z.object({ kind: z.literal("unsupported_protection"), detail: z.string() }),
  z.object({ kind: z.literal("unresolved_outcome"), attemptId: z.string() }),
  /**
   * A re-read or re-query never established the approved evidence. Incomplete pagination,
   * a missing read, or a different predicate is not proof that nothing changed.
   */
  z.object({
    kind: z.literal("evidence_unavailable"),
    evidenceId: z.string().min(1),
    detail: z.string().min(1),
  }),
]);
export type HoldReason = z.infer<typeof HoldReason>;

export const ReceiptOutcome = z.enum([
  "confirmed",
  "rejected",
  "held",
  "unknown_outcome",
  "skipped_dependency",
  "compensated",
  "compensation_conflict",
]);
export type ReceiptOutcome = z.infer<typeof ReceiptOutcome>;

export const Receipt = z.object({
  id: z.string().min(1),
  actionId: z.string().min(1),
  planHash: Sha256Hex,
  approvalId: z.string().min(1),
  outcome: ReceiptOutcome,
  providerRef: EntityRef.nullable(),
  /** What we actually observed after the effect (read back), not what we expected. */
  observedEffect: z.record(z.string(), z.unknown()),
  protection: ProtectionLevel,
  holdReason: HoldReason.nullable(),
  limitations: z.array(z.string()),
  recordedAt: Timestamp,
});
export type Receipt = z.infer<typeof Receipt>;

/** Maps a plan-time ResultRef to the ID actually returned by the operational world. */
export const ObjectBinding = z.object({
  planHash: Sha256Hex,
  ref: ResultRef,
  value: z.union([z.string(), z.number()]),
});
export type ObjectBinding = z.infer<typeof ObjectBinding>;

export const RunEvent = z.object({
  seq: z.int().nonnegative(),
  runId: z.string().min(1),
  type: z.string().min(1),
  at: Timestamp,
  payload: z.unknown(),
});
export type RunEvent = z.infer<typeof RunEvent>;
