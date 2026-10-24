import { Sha256Hex } from "@rehearsal/contracts";
import { z } from "zod";
import { PrecedentId } from "./precedent";
import type { PrecedentRecall } from "./precedents";

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

export function citePrecedents(recall: PrecedentRecall): PrecedentCitation[] {
  return recall.precedents.map((p) => ({
    id: p.id,
    version: p.version,
    digest: p.digest,
    appliesTo: p.record.appliesTo,
    factIds: p.factIds,
    traceId: recall.traceId,
  }));
}

/** The precedent registry as read in one transaction at apply time (Postgres, not memory). */
export interface RegistrySnapshot {
  /** Active approved versions by precedent ID. A withdrawn or not-yet-synced one is absent. */
  active: ReadonlyMap<string, { version: number; digest: Sha256Hex }>;
  /** Current epoch by area. An area with no history is at 0. */
  epochs: ReadonlyMap<string, number>;
}

export type PrecedentHold =
  | {
      id: string;
      reason: "withdrawn" | "superseded" | "not_active" | "content_changed";
      citedVersion: number;
      activeVersion: number | null;
    }
  | { appliesTo: string; reason: "epoch_changed"; plannedEpoch: number; currentEpoch: number };

/**
 * Whether the precedents a plan rests on still hold, decided from the registry alone. Any hold
 * holds every step that depends on the plan's precedents; recall is never asked.
 */
export function checkPrecedentBasis(
  input: PrecedentBasis,
  registry: RegistrySnapshot,
): { ok: true } | { ok: false; holds: PrecedentHold[] } {
  const basis = PrecedentBasis.parse(input);
  const holds: PrecedentHold[] = [];
  for (const cited of basis.citations) {
    const active = registry.active.get(cited.id);
    const base = {
      id: cited.id,
      citedVersion: cited.version,
      activeVersion: active?.version ?? null,
    };
    if (active === undefined) holds.push({ ...base, reason: "withdrawn" });
    else if (active.version > cited.version) holds.push({ ...base, reason: "superseded" });
    else if (active.version < cited.version) holds.push({ ...base, reason: "not_active" });
    else if (active.digest !== cited.digest) holds.push({ ...base, reason: "content_changed" });
  }
  for (const [appliesTo, plannedEpoch] of Object.entries(basis.epochs)) {
    const currentEpoch = registry.epochs.get(appliesTo) ?? 0;
    if (currentEpoch !== plannedEpoch) {
      holds.push({ appliesTo, reason: "epoch_changed", plannedEpoch, currentEpoch });
    }
  }
  return holds.length === 0 ? { ok: true } : { ok: false, holds };
}
