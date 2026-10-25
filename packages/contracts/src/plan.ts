import { z } from "zod";
import { Action } from "./actions";
import { CONTRACTS_VERSION, PolicyRef, Role, Sha256Hex, Timestamp } from "./common";
import { Observation, QueryObservation } from "./observations";
import { PrecedentBasis } from "./precedents";

/**
 * The immutable thing a reviewer approves. Its canonical hash (RFC 8785 + SHA-256) is what an
 * ApprovalGrant binds to. Any execution-affecting change is a new revision with a new hash.
 * Timestamps of creation live on the DB row, not here, so the hash only covers content.
 */
export const PlanManifest = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  orgId: z.string().min(1),
  incidentId: z.string().min(1),
  planId: z.string().min(1),
  revision: z.int().positive(),
  parentRevision: z.int().positive().nullable(),
  /** Logical target only; the server maps it to world URLs. Never a URL from the planner. */
  target: z.object({ environment: z.literal("operational") }),
  versions: z.object({
    planner: z.object({
      model: z.string().min(1),
      promptVersion: z.string().min(1),
      toolSchemaHash: Sha256Hex,
    }),
    adapters: z.record(z.string(), z.string()),
  }),
  policies: z.array(PolicyRef).min(1),
  observations: z.array(Observation),
  queryObservations: z.array(QueryObservation),
  /** Ordered. Canonicalization sorts object keys, never this array. */
  actions: z.array(Action),
  /** Actions the reviewer removed (with dependents), for audit. */
  excluded: z.array(z.object({ actionId: z.string(), reason: z.enum(["reviewer", "dependency"]) })),
  /**
   * The precedents the planner relied on, with the registry epoch of each area it consulted.
   * Absent for a plan that used none, so every plan made before this field keeps its hash.
   */
  precedentBasis: PrecedentBasis.optional(),
});
export type PlanManifest = z.infer<typeof PlanManifest>;

export const ApprovalGrant = z.object({
  id: z.string().min(1),
  orgId: z.string().min(1),
  planId: z.string().min(1),
  revision: z.int().positive(),
  planHash: Sha256Hex,
  actorUserId: z.string().min(1),
  actorSessionId: z.string().min(1),
  /** Roles the actor held when granting, as verified server-side. */
  roles: z.array(Role).min(1),
  grantedAt: Timestamp,
  expiresAt: Timestamp,
  revokedAt: Timestamp.nullable(),
});
export type ApprovalGrant = z.infer<typeof ApprovalGrant>;
