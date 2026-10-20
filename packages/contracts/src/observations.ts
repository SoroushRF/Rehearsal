import { z } from "zod";
import { EntityRef, Sha256Hex, Timestamp, Vendor, World } from "./common";

/** A single-record read the plan depends on. */
export const Observation = z.object({
  id: z.string().min(1),
  world: World,
  entity: EntityRef,
  /** Version of the semantic projection (which fields matter), so fingerprints stay comparable. */
  projectionVersion: z.string().min(1),
  projection: z.record(z.string(), z.unknown()),
  fingerprint: Sha256Hex,
  capturedAt: Timestamp,
});
export type Observation = z.infer<typeof Observation>;

/**
 * Supported query predicates only. No free-form search: phantom detection needs to re-run the
 * exact same predicate and enumerate the complete population.
 */
export const QueryPredicate = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("stripe.charges.byCustomerInWindow"),
    customerId: z.string().min(1),
    createdGte: Timestamp,
    createdLt: Timestamp,
  }),
  z.object({
    kind: z.literal("zendesk.tickets.byRequester"),
    requesterId: z.string().min(1),
  }),
]);
export type QueryPredicate = z.infer<typeof QueryPredicate>;

export const QueryObservation = z.object({
  id: z.string().min(1),
  world: World,
  vendor: Vendor,
  predicate: QueryPredicate,
  /** Fixed cutoff the query was evaluated at. */
  cutoff: Timestamp,
  /** True only if every page was fetched. Incomplete enumeration is never proof of absence. */
  complete: z.boolean(),
  /** Sorted IDs of every matching record (may be empty — an empty match is still evidence). */
  matchingIds: z.array(z.string()),
  projectionVersion: z.string().min(1),
  projections: z.record(z.string(), z.record(z.string(), z.unknown())),
  fingerprint: Sha256Hex,
  capturedAt: Timestamp,
});
export type QueryObservation = z.infer<typeof QueryObservation>;
