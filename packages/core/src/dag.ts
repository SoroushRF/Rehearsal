import type { Action, PlanManifest } from "@rehearsal/contracts";

export interface GraphIssue {
  actionId: string;
  problem:
    | "duplicate_id"
    | "unknown_dependency"
    | "self_dependency"
    | "cycle"
    | "unbound_result_ref";
  detail: string;
}

/** Structural checks on the explicit dependency graph. Empty array = valid. */
export function validateGraph(actions: readonly Action[]): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const ids = new Set<string>();
  for (const a of actions) {
    if (ids.has(a.id)) issues.push({ actionId: a.id, problem: "duplicate_id", detail: a.id });
    ids.add(a.id);
  }
  for (const a of actions) {
    for (const dep of a.dependsOn) {
      if (dep === a.id) issues.push({ actionId: a.id, problem: "self_dependency", detail: dep });
      else if (!ids.has(dep))
        issues.push({ actionId: a.id, problem: "unknown_dependency", detail: dep });
    }
    // A step may only bind to results of steps it explicitly depends on.
    if (a.kind === "zendesk.ticket.appendPrivateNote") {
      for (const [name, b] of Object.entries(a.args.bindings)) {
        if (typeof b === "object" && !a.dependsOn.includes(b.stepId)) {
          issues.push({
            actionId: a.id,
            problem: "unbound_result_ref",
            detail: `binding "${name}" refers to ${b.stepId}, which is not in dependsOn`,
          });
        }
      }
    }
  }
  if (issues.length === 0) {
    try {
      topoOrder(actions);
    } catch (e) {
      issues.push({ actionId: "*", problem: "cycle", detail: (e as Error).message });
    }
  }
  return issues;
}

/** Kahn's algorithm, stable with respect to manifest order. Throws on a cycle. */
export function topoOrder(actions: readonly Action[]): Action[] {
  const remaining = new Map(actions.map((a) => [a.id, new Set(a.dependsOn)]));
  const order: Action[] = [];
  while (order.length < actions.length) {
    const next = actions.find((a) => remaining.has(a.id) && remaining.get(a.id)?.size === 0);
    if (!next) throw new Error(`dependency cycle among: ${[...remaining.keys()].join(", ")}`);
    order.push(next);
    remaining.delete(next.id);
    for (const deps of remaining.values()) deps.delete(next.id);
  }
  return order;
}

/** The given IDs plus everything that transitively depends on them. */
export function dependentsClosure(actions: readonly Action[], ids: Iterable<string>): Set<string> {
  const closed = new Set(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const a of actions) {
      if (!closed.has(a.id) && a.dependsOn.some((d) => closed.has(d))) {
        closed.add(a.id);
        grew = true;
      }
    }
  }
  return closed;
}

/**
 * Reviewer unchecks actions → a NEW immutable revision without them and their dependents.
 * The original revision is never edited.
 */
export function excludeActions(manifest: PlanManifest, ids: readonly string[]): PlanManifest {
  const known = new Set(manifest.actions.map((a) => a.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new Error(`unknown action ids: ${unknown.join(", ")}`);

  const requested = new Set(ids);
  const removed = dependentsClosure(manifest.actions, ids);
  return {
    ...manifest,
    revision: manifest.revision + 1,
    parentRevision: manifest.revision,
    actions: manifest.actions.filter((a) => !removed.has(a.id)),
    excluded: [
      ...manifest.excluded,
      ...manifest.actions
        .filter((a) => removed.has(a.id))
        .map((a) => ({
          actionId: a.id,
          reason: requested.has(a.id) ? ("reviewer" as const) : ("dependency" as const),
        })),
    ],
  };
}
