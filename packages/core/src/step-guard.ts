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
import type { StepGuard, StepGuardContext } from "./executor";
import {
  advanceOverlay,
  emptyOverlay,
  entityKey,
  guardAction,
  type OwnWriteOverlay,
} from "./guards";
import type { Clock, ProviderPort, WorldContext } from "./ports";
import { oneRemedyHold, type RemedyStep, remedyOf, type SeenCredit } from "./remedy";

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
  return async (action: Action, context) => {
    const { manifest, confirmedReceipts } = context;
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
    const remedy = remedyOf(action);
    return remedy ? readRemedyHold(deps, remedy, context) : null;
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
    const remedy = prior && remedyOf(prior);
    if (remedy) settled.set(remedy.obligationId, remedy.id);
  }
  return settled;
}

/**
 * How much of this charge the approved evidence already showed refunded, plus this plan's own
 * confirmed refunds of it. A fresh read above that is a refund nobody here accounts for.
 */
function explainedRefunded(
  step: RemedyStep,
  manifest: PlanManifest,
  receipts: readonly Receipt[],
): number {
  const evidenced = manifest.observations
    .filter(
      (o) =>
        o.entity.vendor === "stripe" && o.entity.kind === "charge" && o.entity.id === step.chargeId,
    )
    .map((o) => o.projection.amount_refunded)
    .filter((v): v is number => typeof v === "number" && Number.isInteger(v));
  let explained = evidenced.length > 0 ? Math.max(...evidenced) : 0;
  for (const receipt of receipts) {
    if (receipt.outcome !== "confirmed") continue;
    const prior = manifest.actions.find((item) => item.id === receipt.actionId);
    const own = prior && remedyOf(prior);
    if (
      own?.kind === "stripe.refund.create" &&
      own.chargeId === step.chargeId &&
      own.id !== step.id
    ) {
      explained += own.amountMinor;
    }
  }
  return explained;
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
 * has a remedy. A missing or incomplete credit list is not proof that no credit exists, and a store
 * that can't list other plans' remedies is not proof that none was sent.
 */
export async function readRemedyHold(
  deps: ReadGuardDeps,
  step: RemedyStep,
  context: StepGuardContext,
): Promise<HoldReason | null> {
  const { manifest, confirmedReceipts, priorRemedies } = context;
  if (!priorRemedies) {
    return {
      kind: "evidence_unavailable",
      evidenceId: step.id,
      detail: "other plans' remedies for this obligation could not be listed",
    };
  }
  const read = await reread(deps, "stripe", step.id, (provider, world) =>
    provider.observe({ vendor: "stripe", kind: "charge", id: step.chargeId }, world),
  );
  if (!read.ok) return read.reason;
  const currentRefunded = read.value.projection.amount_refunded;
  if (typeof currentRefunded !== "number" || !Number.isInteger(currentRefunded)) {
    return {
      kind: "evidence_unavailable",
      evidenceId: step.id,
      detail: "charge re-read has no refunded amount",
    };
  }
  const refunded = currentRefunded > explainedRefunded(step, manifest, confirmedReceipts);
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
    priorRemedies,
    refundedChargeIds: refunded ? new Set([step.chargeId]) : new Set(),
    credits,
  });
}
