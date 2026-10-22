import type {
  Action,
  HoldReason,
  Observation,
  PlanManifest,
  QueryObservation,
  Receipt,
  Vendor,
} from "@rehearsal/contracts";
import type { StepGuard } from "./executor";
import { advanceOverlay, emptyOverlay, guardAction, type OwnWriteOverlay } from "./guards";
import type { Clock, ProviderPort, WorldContext } from "./ports";

export interface ReadGuardDeps {
  providers: Partial<Record<Vendor, ProviderPort>>;
  /** Operational world tenant per vendor. */
  worlds: Partial<Record<Vendor, WorldContext>>;
  clock: Clock;
}

type Read<T> = { ok: true; value: T } | { ok: false; reason: HoldReason };

function unavailable(evidenceId: string, detail: string): Read<never> {
  return { ok: false, reason: { kind: "evidence_unavailable", evidenceId, detail } };
}

async function reread<T>(
  deps: ReadGuardDeps,
  vendor: Vendor,
  evidenceId: string,
  read: (provider: ProviderPort, world: WorldContext) => Promise<T>,
): Promise<Read<T>> {
  const provider = deps.providers[vendor];
  const world = deps.worlds[vendor];
  if (!provider || !world) return unavailable(evidenceId, `no operational reader for ${vendor}`);
  try {
    return { ok: true, value: await read(provider, world) };
  } catch (err) {
    return unavailable(evidenceId, `re-read failed: ${(err as Error).message}`);
  }
}

/** Expected values after every confirmed write of this plan hash, so our own writes don't hold. */
export function overlayFromReceipts(
  manifest: PlanManifest,
  receipts: readonly Receipt[],
): OwnWriteOverlay {
  let overlay = emptyOverlay();
  for (const receipt of receipts) {
    const action = manifest.actions.find((a) => a.id === receipt.actionId);
    if (action) overlay = advanceOverlay(overlay, action, receipt, manifest.observations);
  }
  return overlay;
}

/**
 * The executor's step guard: re-read this action's approved evidence from the operational world and
 * hold on any drift. A reader that is missing or fails holds; it never counts as "nothing changed".
 */
export function createReadGuard(deps: ReadGuardDeps): StepGuard {
  return async (action: Action, { manifest, confirmedReceipts }) => {
    const currentObservations: Observation[] = [];
    for (const id of action.evidence) {
      const planned = manifest.observations.find((o) => o.id === id);
      if (!planned) continue;
      const read = await reread(deps, planned.entity.vendor, id, (provider, world) =>
        provider.observe(planned.entity, world),
      );
      if (!read.ok) return read.reason;
      currentObservations.push(read.value);
    }

    const currentQueries: QueryObservation[] = [];
    for (const id of action.queryEvidence) {
      const planned = manifest.queryObservations.find((q) => q.id === id);
      if (!planned) continue;
      const cutoff = deps.clock.now().toISOString();
      const read = await reread(deps, planned.vendor, id, (provider, world) =>
        provider.query(planned.predicate, cutoff, world),
      );
      if (!read.ok) return read.reason;
      currentQueries.push(read.value);
    }

    const verdict = guardAction({
      action,
      plannedObservations: manifest.observations,
      currentObservations,
      plannedQueries: manifest.queryObservations,
      currentQueries,
      overlay: overlayFromReceipts(manifest, confirmedReceipts),
    });
    return verdict.decision === "hold" ? verdict.reason : null;
  };
}
