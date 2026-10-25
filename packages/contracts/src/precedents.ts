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
