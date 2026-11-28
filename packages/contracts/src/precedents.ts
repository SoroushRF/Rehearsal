import { z } from "zod";
import { Sha256Hex } from "./common";

/** A stable lowercase slug. The memory entity is named `precedent:<id>`. */
export const PrecedentId = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "precedent id must be a lowercase slug");

/** One precedent a plan relied on, as planning recalled it (build plan §7). */
export const PrecedentCitation = z.strictObject({
  id: PrecedentId,
  version: z.int().positive(),
  digest: Sha256Hex,
  appliesTo: z.string().min(1),
  factIds: z.array(z.string().min(1)),
  traceId: z.string().min(1).nullable(),
});
export type PrecedentCitation = z.infer<typeof PrecedentCitation>;

/**
 * What a plan's precedents rest on: the versions it cited, plus the registry epoch of every
 * area it consulted. The epoch is how a precedent recall never surfaced still holds the plan:
 * activating, changing or withdrawing any precedent in an area bumps its epoch, so the check
 * doesn't depend on recall being complete.
 */
export const PrecedentBasis = z
  .strictObject({
    citations: z.array(PrecedentCitation),
    epochs: z.record(z.string().min(1), z.int().nonnegative()),
  })
  .refine((b) => b.citations.every((c) => c.appliesTo in b.epochs), {
    message: "every cited area needs its epoch",
    path: ["epochs"],
  });
export type PrecedentBasis = z.infer<typeof PrecedentBasis>;

/** Caps on recall diagnostics, so a misbehaving recall can't grow what is stored per plan. */
export const RECALL_DIAGNOSTICS_LIMITS = {
  areas: 64,
  perArea: 64,
  factIds: 16,
  hitIds: 64,
  text: 256,
  reason: 500,
} as const;
const L = RECALL_DIAGNOSTICS_LIMITS;
const DiagnosticText = z.string().min(1).max(L.text);

/** A precedent recall returned for an area: readback accepted it and it's effective today. */
export const PrecedentRecallHit = z.strictObject({
  id: PrecedentId,
  version: z.int().positive(),
  factIds: z.array(DiagnosticText).max(L.factIds),
  hitIds: z.array(DiagnosticText).max(L.hitIds),
});
export type PrecedentRecallHit = z.infer<typeof PrecedentRecallHit>;

/**
 * A precedent planning didn't cite, and why. `recall`: a hit pointed at it, but Agent Memory's
 * copy was absent, invalid, withdrawn or not effective. `registry`: recall returned it, but it
 * isn't the version and digest the Postgres registry lists as active.
 */
export const PrecedentRecallDrop = z.strictObject({
  id: PrecedentId,
  reason: z.string().min(1).max(L.reason),
  stage: z.enum(["recall", "registry"]),
});
export type PrecedentRecallDrop = z.infer<typeof PrecedentRecallDrop>;

/** One recall planning made: the area, the query text it sent, the trace, its hits and drops. */
export const PrecedentRecallArea = z.strictObject({
  area: DiagnosticText,
  query: DiagnosticText,
  traceId: DiagnosticText.nullable(),
  hits: z.array(PrecedentRecallHit).max(L.perArea),
  dropped: z.array(PrecedentRecallDrop).max(L.perArea),
});
export type PrecedentRecallArea = z.infer<typeof PrecedentRecallArea>;

/**
 * Why each precedent was or wasn't recalled for one plan revision (T1.54). It explains a
 * `PrecedentBasis` and is stored beside the plan, never in the manifest, so it doesn't change
 * the plan hash; nothing approves, holds or executes from it. `recalled` is false when nothing
 * was active in the registry, so planning never asked Agent Memory and `areas` is empty.
 */
export const PrecedentRecallDiagnostics = z.strictObject({
  recalled: z.boolean(),
  areas: z.array(PrecedentRecallArea).max(L.areas),
});
export type PrecedentRecallDiagnostics = z.infer<typeof PrecedentRecallDiagnostics>;
