import { PrecedentBasis, type Sha256Hex } from "@rehearsal/contracts";

/**
 * Whether the precedents a plan rests on still hold (build plan §7). Pure: it reads a plan's basis
 * and a registry snapshot, nothing else. It lives here, not in `@rehearsal/memory`, because the
 * executor needs it at admission and `core` can't depend on `memory` (memory depends on core).
 * `@rehearsal/memory` re-exports it.
 */

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

/** One line for a refusal or log: what changed under the plan. */
export function describePrecedentHold(h: PrecedentHold): string {
  if ("appliesTo" in h) {
    return `precedents in ${h.appliesTo} changed since planning (set ${h.plannedEpoch}, now ${h.currentEpoch})`;
  }
  const to = h.activeVersion === null ? "none in force" : `v${h.activeVersion} in force`;
  return `${h.id} v${h.citedVersion} is ${h.reason.replace("_", " ")} (${to})`;
}

/** Reads the precedent registry for one organization. Postgres in production; never memory. */
export interface PrecedentRegistryPort {
  snapshot(orgId: string): Promise<RegistrySnapshot>;
}
