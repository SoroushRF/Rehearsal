import type {
  Action,
  HoldReason,
  Observation,
  PlanManifest,
  QueryObservation,
  Receipt,
  Vendor,
} from "@rehearsal/contracts";
import { canonicalize } from "./canonical";
import type { StepGuard } from "./executor";
import {
  advanceOverlay,
  emptyOverlay,
  entityKey,
  guardAction,
  type OwnWriteOverlay,
} from "./guards";
import type { Clock, ProviderPort, WorldContext } from "./ports";
import { oneRemedyHold, type RemedyStep, type SeenCredit } from "./remedy";

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
  const ordered = [...receipts].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  for (const receipt of ordered) {
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
    // One re-read per record and per query, even when several planned observations cite it.
    const currentObservations: Observation[] = [];
    const readEntities = new Set<string>();
    for (const id of action.evidence) {
      const planned = manifest.observations.find((o) => o.id === id);
      if (!planned || readEntities.has(entityKey(planned.entity))) continue;
      readEntities.add(entityKey(planned.entity));
      const read = await reread(deps, planned.entity.vendor, id, (provider, world) =>
        provider.observe(planned.entity, world),
      );
      if (!read.ok) return read.reason;
      currentObservations.push(read.value);
    }

    const currentQueries: QueryObservation[] = [];
    const readQueries = new Set<string>();
    for (const id of action.queryEvidence) {
      const planned = manifest.queryObservations.find((q) => q.id === id);
      const queryKey = planned && canonicalize({ vendor: planned.vendor, p: planned.predicate });
      if (!planned || !queryKey || readQueries.has(queryKey)) continue;
      readQueries.add(queryKey);
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
    if (verdict.decision === "hold") return verdict.reason;
    if (action.kind !== "stripe.refund.create") return null;
    return readRemedyHold(
      deps,
      {
        id: action.id,
        obligationId: action.obligationId,
        kind: action.kind,
        chargeId: action.args.chargeId,
        amountMinor: action.args.amount.amountMinor,
        currency: action.args.amount.currency,
      },
      manifest,
      confirmedReceipts,
    );
  };
}

/** The kind a Stripe reader lists invoice credits under. The id is the customer. */
export const BALANCE_CREDITS = "customer_balance_transactions";

function settledRemedies(
  manifest: PlanManifest,
  receipts: readonly Receipt[],
): Map<string, string> {
  const settled = new Map<string, string>();
  for (const receipt of receipts) {
    if (receipt.outcome !== "confirmed") continue;
    const prior = manifest.actions.find((item) => item.id === receipt.actionId);
    if (prior?.kind === "stripe.refund.create") settled.set(prior.obligationId, prior.id);
  }
  return settled;
}

function creditsFrom(projection: Record<string, unknown>): SeenCredit[] | null {
  if (projection.complete !== true || !Array.isArray(projection.credits)) return null;
  const credits: SeenCredit[] = [];
  for (const item of projection.credits) {
    if (typeof item !== "object" || item === null) return null;
    const credit = item as Record<string, unknown>;
    if (
      typeof credit.id !== "string" ||
      typeof credit.amountMinor !== "number" ||
      !Number.isInteger(credit.amountMinor) ||
      typeof credit.currency !== "string" ||
      (credit.chargeId !== null && typeof credit.chargeId !== "string")
    ) {
      return null;
    }
    credits.push({
      id: credit.id,
      amountMinor: credit.amountMinor,
      currency: credit.currency,
      chargeId: typeof credit.chargeId === "string" ? credit.chargeId : null,
    });
  }
  return credits;
}

/**
 * Re-read the charge and the customer's balance credits, then hold when this obligation already
 * has a remedy. A missing or incomplete credit list is not proof that no credit exists.
 */
export async function readRemedyHold(
  deps: ReadGuardDeps,
  step: RemedyStep,
  manifest: PlanManifest,
  confirmedReceipts: readonly Receipt[],
): Promise<HoldReason | null> {
  const read = await reread(deps, "stripe", step.id, (provider, world) =>
    provider.observe({ vendor: "stripe", kind: "charge", id: step.chargeId }, world),
  );
  if (!read.ok) return read.reason;
  const currentRefunded = read.value.projection.amount_refunded;
  const refunded = typeof currentRefunded === "number" && currentRefunded > 0;
  const customer = read.value.projection.customer;
  if (typeof customer !== "string" || customer.length === 0) {
    return {
      kind: "evidence_unavailable",
      evidenceId: step.id,
      detail: "charge re-read has no customer, so its credits cannot be listed",
    };
  }
  const listed = await reread(deps, "stripe", step.id, (provider, world) =>
    provider.observe({ vendor: "stripe", kind: BALANCE_CREDITS, id: customer }, world),
  );
  if (!listed.ok) return listed.reason;
  if (listed.value.projection.complete === false) {
    return {
      kind: "evidence_unavailable",
      evidenceId: step.id,
      detail: "the customer's balance credits could not be listed completely",
    };
  }
  const credits = creditsFrom(listed.value.projection);
  if (!credits) {
    return {
      kind: "evidence_unavailable",
      evidenceId: step.id,
      detail: "the balance-credit read was not a complete list",
    };
  }
  return oneRemedyHold({
    step,
    settledBy: settledRemedies(manifest, confirmedReceipts),
    refundedChargeIds: refunded ? new Set([step.chargeId]) : new Set(),
    credits,
  });
}
