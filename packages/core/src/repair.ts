import type { Action, PlanManifest, Receipt, Vendor } from "@rehearsal/contracts";
import { fingerprint } from "./hash";

/**
 * T1.37: repairing a held run (decision 0016). A run that held a step leaves the plan partly
 * applied. A repair turns its unfinished cases into a new revision: what the run confirmed is
 * kept verbatim, so the executor adopts its receipt by operation key and never sends it again;
 * the rest of those cases is planned afresh on a refreshed planning copy and approved again.
 */

/** A record a hold found in the operational world that the planning copy lacks. */
export interface RepairRefresh {
  vendor: Vendor;
  kind: "charge" | "ticket";
  id: string;
}

export type RepairScope =
  | {
      ok: true;
      /** Confirmed steps of the base revision, carried into the repair unchanged. */
      kept: string[];
      /** Cases with unfinished work; only these are planned again. */
      openCases: string[];
      /** Unfinished steps the new revision replaces (planned again, or left out). */
      replanned: string[];
      /** Records the planning copy needs before the cases are planned again. */
      refresh: RepairRefresh[];
    }
  | { ok: false; reason: string };

const isSummary = (a: Action) => a.kind === "slack.message.postSummary";

/**
 * What a repair of `manifest` would keep, plan again and refresh, from every receipt recorded for
 * its hash (oldest first) and the steps whose send is still in flight. Refuses anything a repair
 * can't make safe: an unknown outcome is reconciled by resuming the run, never replanned around.
 */
export function repairScope(
  manifest: PlanManifest,
  receipts: readonly Receipt[],
  inFlight: readonly string[],
): RepairScope {
  const latest = new Map<string, Receipt>();
  for (const r of receipts) latest.set(r.actionId, r);
  const queries = new Map(manifest.queryObservations.map((q) => [q.id, q]));

  const kept: string[] = [];
  const replanned: string[] = [];
  const refresh = new Map<string, RepairRefresh>();
  for (const action of manifest.actions) {
    if (inFlight.includes(action.id)) {
      return { ok: false, reason: `${action.id} has a send in flight; resume the run first` };
    }
    const receipt = latest.get(action.id);
    // A summary reports on one run; the repair's own run gets its own summary.
    if (isSummary(action)) {
      replanned.push(action.id);
      continue;
    }
    if (receipt?.outcome === "confirmed") {
      kept.push(action.id);
      continue;
    }
    // Never ran (a cancelled run, say), or skipped because a step it depends on didn't go out.
    if (!receipt || receipt.outcome === "skipped_dependency") {
      replanned.push(action.id);
      continue;
    }
    if (receipt.outcome !== "held") {
      return {
        ok: false,
        reason: `${action.id} ended ${receipt.outcome}; a repair only replans held or skipped steps`,
      };
    }
    const hold = receipt.holdReason;
    if (hold?.kind === "predecessor_not_confirmed") {
      replanned.push(action.id);
      continue;
    }
    if (hold?.kind !== "query_membership_changed") {
      return {
        ok: false,
        reason: `${action.id} is held (${hold?.kind ?? "no reason"}); a repair can't refresh that, so resume the run or exclude the step`,
      };
    }
    const query = queries.get(hold.queryObservationId);
    if (!query) return { ok: false, reason: `${action.id} cites a query the plan lacks` };
    if (hold.removed.length > 0) {
      return {
        ok: false,
        reason: `${action.id}: ${hold.removed.join(", ")} left the query; the planning copy can't drop them`,
      };
    }
    const kind = query.vendor === "stripe" ? "charge" : "ticket";
    for (const id of hold.added)
      refresh.set(`${query.vendor}/${id}`, { vendor: query.vendor, kind, id });
    replanned.push(action.id);
  }

  const byId = new Map(manifest.actions.map((a) => [a.id, a]));
  const openCases = [
    ...new Set(
      replanned
        .map((id) => byId.get(id))
        .filter((a): a is Action => !!a && !isSummary(a))
        .map((a) => a.caseId),
    ),
  ];
  if (openCases.length === 0)
    return { ok: false, reason: "every step was confirmed; nothing to repair" };
  for (const id of kept) {
    const missing = byId.get(id)?.dependsOn.filter((dep) => !kept.includes(dep)) ?? [];
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `${id} was confirmed before ${missing.join(", ")}; resume the run`,
      };
    }
  }
  return { ok: true, kept, openCases, replanned, refresh: [...refresh.values()] };
}

/**
 * Problems with a planner's repair of `base` (empty when it is acceptable). The repair is the next
 * revision of the same plan; every kept step and the evidence it cites are byte-for-byte the base
 * revision's; every other step belongs to an open case (or is the run summary); nothing the reviewer
 * excluded comes back.
 */
export function checkRepair(
  base: PlanManifest,
  scope: { kept: readonly string[]; openCases: readonly string[] },
  next: PlanManifest,
): string[] {
  const problems: string[] = [];
  if (
    next.orgId !== base.orgId ||
    next.planId !== base.planId ||
    next.incidentId !== base.incidentId
  ) {
    problems.push("the repair is for another org, plan or incident");
  }
  if (next.revision !== base.revision + 1 || next.parentRevision !== base.revision) {
    problems.push(`a repair of revision ${base.revision} is revision ${base.revision + 1}`);
  }
  const same = <T>(a: T | undefined, b: T | undefined) =>
    a !== undefined && b !== undefined && fingerprint(a) === fingerprint(b);
  const baseActions = new Map(base.actions.map((a) => [a.id, a]));
  const nextActions = new Map(next.actions.map((a) => [a.id, a]));
  const baseObs = new Map(base.observations.map((o) => [o.id, o]));
  const nextObs = new Map(next.observations.map((o) => [o.id, o]));
  const baseQueries = new Map(base.queryObservations.map((q) => [q.id, q]));
  const nextQueries = new Map(next.queryObservations.map((q) => [q.id, q]));
  const keptSet = new Set(scope.kept);
  for (const id of scope.kept) {
    const before = baseActions.get(id);
    if (!same(before, nextActions.get(id))) {
      problems.push(`kept step ${id} changed or is missing`);
      continue;
    }
    for (const e of before?.evidence ?? []) {
      if (!same(baseObs.get(e), nextObs.get(e)))
        problems.push(`kept step ${id}: evidence ${e} changed`);
    }
    for (const q of before?.queryEvidence ?? []) {
      if (!same(baseQueries.get(q), nextQueries.get(q)))
        problems.push(`kept step ${id}: query ${q} changed`);
    }
  }
  const open = new Set(scope.openCases);
  const excluded = new Set(base.excluded.map((e) => e.actionId));
  for (const a of next.actions) {
    if (keptSet.has(a.id)) continue;
    if (excluded.has(a.id)) problems.push(`${a.id} was excluded by a reviewer`);
    if (!isSummary(a) && !open.has(a.caseId))
      problems.push(`${a.id} is outside the repaired cases`);
  }
  return problems;
}
