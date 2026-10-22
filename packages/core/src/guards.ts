import type {
  Action,
  HoldReason,
  Observation,
  QueryObservation,
  Receipt,
} from "@rehearsal/contracts";
import { canonicalize } from "./canonical";

/**
 * Pure admission checks. T3 calls these before dispatch. They do not read the network
 * and they do not decide that a dependent step is skipped; the executor does that.
 *
 * A missing, partial, or mismatched re-check holds. It is never treated as "nothing changed".
 */

/** Expected field values after our own confirmed writes. Anything else leaves this unchanged. */
export interface OwnWriteOverlay {
  readonly byObservation: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export function emptyOverlay(): OwnWriteOverlay {
  return { byObservation: {} };
}

export type GuardVerdict = { decision: "admit" } | { decision: "hold"; reason: HoldReason };

function admit(): GuardVerdict {
  return { decision: "admit" };
}

function hold(reason: HoldReason): GuardVerdict {
  return { decision: "hold", reason };
}

function unavailable(evidenceId: string, detail: string): GuardVerdict {
  return hold({ kind: "evidence_unavailable", evidenceId, detail });
}

function same(a: unknown, b: unknown): boolean {
  try {
    return canonicalize(a) === canonicalize(b);
  } catch {
    return false;
  }
}

function sameEntity(a: Observation["entity"], b: Observation["entity"]): boolean {
  return a.vendor === b.vendor && a.kind === b.kind && a.id === b.id;
}

/**
 * Compare the semantic projection the plan recorded with a fresh read of the same record.
 * Overlay values replace the planned field, so a later step does not hold on our own write.
 * Fields outside the planned projection are ignored. World, id, and fingerprint are not compared.
 */
export function compareObservation(
  planned: Observation,
  current: Observation,
  overlay: OwnWriteOverlay = emptyOverlay(),
): GuardVerdict {
  if (!sameEntity(planned.entity, current.entity)) {
    return unavailable(planned.id, "re-read is a different record");
  }
  if (planned.projectionVersion !== current.projectionVersion) {
    return unavailable(planned.id, "projection version differs");
  }

  const overrides = overlay.byObservation[planned.id];
  const fields: string[] = [];
  for (const field of Object.keys(planned.projection).sort()) {
    const expected =
      overrides !== undefined && Object.hasOwn(overrides, field)
        ? overrides[field]
        : planned.projection[field];
    const actual = Object.hasOwn(current.projection, field) ? current.projection[field] : undefined;
    if (!same(expected, actual)) fields.push(field);
  }
  if (fields.length === 0) return admit();
  return hold({ kind: "row_changed", observationId: planned.id, fields });
}

/**
 * Set difference of a fully enumerated query. Empty matching sets are real evidence.
 * An incomplete enumeration, or a re-query that is not the approved predicate, holds
 * without claiming which ids appeared or disappeared.
 */
export function diffQueryMembership(
  planned: QueryObservation,
  current: QueryObservation,
): GuardVerdict {
  if (!planned.complete) {
    return unavailable(planned.id, "planned query enumeration is incomplete");
  }
  if (!current.complete) {
    return unavailable(planned.id, "current query enumeration is incomplete");
  }
  if (planned.vendor !== current.vendor || !same(planned.predicate, current.predicate)) {
    return unavailable(planned.id, "predicate differs from the approved query");
  }
  if (planned.projectionVersion !== current.projectionVersion) {
    return unavailable(planned.id, "projection version differs");
  }

  const before = new Set(planned.matchingIds);
  const after = new Set(current.matchingIds);
  const added = [...after].filter((id) => !before.has(id)).sort();
  const removed = [...before].filter((id) => !after.has(id)).sort();
  if (added.length === 0 && removed.length === 0) return admit();
  return hold({
    kind: "query_membership_changed",
    queryObservationId: planned.id,
    added,
    removed,
  });
}

function isMinor(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function baselineMinor(
  overlay: OwnWriteOverlay,
  observation: Observation,
  field: string,
): number | undefined {
  const overrides = overlay.byObservation[observation.id];
  if (overrides !== undefined && Object.hasOwn(overrides, field)) {
    return isMinor(overrides[field]) ? overrides[field] : undefined;
  }
  if (!Object.hasOwn(observation.projection, field)) return undefined;
  const projected = observation.projection[field];
  return isMinor(projected) ? projected : undefined;
}

function setField(
  overlay: OwnWriteOverlay,
  observationId: string,
  field: string,
  value: unknown,
): OwnWriteOverlay {
  const prior = overlay.byObservation[observationId] ?? {};
  return {
    byObservation: {
      ...overlay.byObservation,
      [observationId]: { ...prior, [field]: value },
    },
  };
}

function evidenceObservation(
  observations: readonly Observation[],
  evidence: readonly string[],
  match: (observation: Observation) => boolean,
): Observation | undefined {
  return observations.find(
    (observation) => evidence.includes(observation.id) && match(observation),
  );
}

/**
 * Move the overlay forward only when the receipt is `confirmed` for this action.
 * A rejected, held, unknown, skipped, or compensation receipt leaves it untouched.
 * A read-back that contradicts the approved write does not count as our value.
 */
export function advanceOverlay(
  overlay: OwnWriteOverlay,
  action: Action,
  receipt: Receipt,
  observations: readonly Observation[],
): OwnWriteOverlay {
  if (receipt.outcome !== "confirmed" || receipt.actionId !== action.id) return overlay;

  if (action.kind === "stripe.refund.create") {
    const observation = evidenceObservation(
      observations,
      action.evidence,
      (item) =>
        item.entity.vendor === "stripe" &&
        item.entity.kind === "charge" &&
        item.entity.id === action.args.chargeId,
    );
    if (!observation) return overlay;
    const prior = baselineMinor(overlay, observation, "amount_refunded");
    if (prior === undefined) return overlay;
    const expected = prior + action.args.amount.amountMinor;
    const seen = receipt.observedEffect.amount_refunded;
    if (seen !== undefined && !same(seen, expected)) return overlay;
    return setField(overlay, observation.id, "amount_refunded", expected);
  }

  if (action.kind === "zendesk.ticket.patchFields") {
    const observation = evidenceObservation(
      observations,
      action.evidence,
      (item) =>
        item.entity.vendor === "zendesk" &&
        item.entity.kind === "ticket" &&
        item.entity.id === action.args.ticketId,
    );
    if (!observation) return overlay;
    let next = overlay;
    for (const [field, written] of Object.entries(action.args.set)) {
      if (written === undefined) continue;
      const seen = receipt.observedEffect[field];
      if (seen !== undefined && !same(seen, written)) continue;
      next = setField(next, observation.id, field, written);
    }
    return next;
  }

  return overlay;
}

function single<T>(matches: T[], evidenceId: string, missing: string): T | GuardVerdict {
  if (matches.length > 1) return unavailable(evidenceId, "more than one re-check matches");
  const [match] = matches;
  return match ?? unavailable(evidenceId, missing);
}

function isVerdict(value: unknown): value is GuardVerdict {
  return typeof value === "object" && value !== null && "decision" in value;
}

export interface GuardActionInput {
  action: Action;
  plannedObservations: readonly Observation[];
  currentObservations: readonly Observation[];
  plannedQueries: readonly QueryObservation[];
  currentQueries: readonly QueryObservation[];
  overlay?: OwnWriteOverlay;
}

/**
 * First failing check on this action's own evidence: rows, then queries.
 * Dependent steps are not considered here.
 */
export function guardAction(input: GuardActionInput): GuardVerdict {
  const overlay = input.overlay ?? emptyOverlay();

  for (const evidenceId of input.action.evidence) {
    const planned = input.plannedObservations.find((item) => item.id === evidenceId);
    if (!planned) return unavailable(evidenceId, "approved evidence is missing from the plan");
    const current = single(
      input.currentObservations.filter((item) => sameEntity(item.entity, planned.entity)),
      planned.id,
      "re-read is missing",
    );
    if (isVerdict(current)) return current;
    const verdict = compareObservation(planned, current, overlay);
    if (verdict.decision === "hold") return verdict;
  }

  for (const evidenceId of input.action.queryEvidence) {
    const planned = input.plannedQueries.find((item) => item.id === evidenceId);
    if (!planned) return unavailable(evidenceId, "approved evidence is missing from the plan");
    const current = single(
      input.currentQueries.filter(
        (item) => item.vendor === planned.vendor && same(item.predicate, planned.predicate),
      ),
      planned.id,
      "query was not re-run",
    );
    if (isVerdict(current)) return current;
    const verdict = diffQueryMembership(planned, current);
    if (verdict.decision === "hold") return verdict;
  }

  return admit();
}
