import { PrecedentBasis, type PrecedentCitation } from "@rehearsal/contracts";
import type { RegistrySnapshot } from "@rehearsal/core";
import type { PrecedentRecall, RecalledPrecedent } from "./precedents";

// The wire schemas live in contracts so a PlanManifest can carry them.
export { PrecedentBasis, PrecedentCitation } from "@rehearsal/contracts";
// The check itself lives in core, where executor admission can use it.
export { checkPrecedentBasis, type PrecedentHold, type RegistrySnapshot } from "@rehearsal/core";

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

/**
 * What planning rests on, from recall filtered by the registry. Every area the registry knows is
 * consulted, and its epoch recorded whether or not recall found anything there. Agent Memory keeps
 * a withdrawn or superseded precedent's copy (decision 0012), so only the exact version and digest
 * the registry lists as active is kept; the rest are dropped with the reason. Null when the
 * registry has no areas, so a plan with no precedents to consult carries no basis at all.
 */
export async function recallBasis(
  recaller: { recall(caseKey: string): Promise<PrecedentRecall> },
  registry: RegistrySnapshot,
): Promise<{
  basis: PrecedentBasis;
  precedents: RecalledPrecedent[];
  dropped: { id: string; reason: string }[];
} | null> {
  const areas = [...registry.epochs.keys()].sort();
  if (areas.length === 0) return null;
  const epochs = Object.fromEntries(areas.map((a) => [a, registry.epochs.get(a) ?? 0]));
  const kept = new Map<string, { precedent: RecalledPrecedent; citation: PrecedentCitation }>();
  const dropped: { id: string; reason: string }[] = [];
  // Nothing active means nothing to cite; the epochs alone still bind the plan.
  if (registry.active.size > 0) {
    for (const area of areas) {
      const recall = await recaller.recall(area);
      for (const p of recall.precedents) {
        if (kept.has(p.id)) continue;
        const active = registry.active.get(p.id);
        const reason =
          active === undefined
            ? "not active in the registry"
            : active.version !== p.version
              ? `registry has version ${active.version}`
              : active.digest !== p.digest
                ? "content differs from the approved version"
                : !(p.record.appliesTo in epochs)
                  ? `area ${p.record.appliesTo} is not in the registry`
                  : null;
        if (reason !== null) {
          if (!dropped.some((d) => d.id === p.id)) dropped.push({ id: p.id, reason });
          continue;
        }
        const citation = {
          id: p.id,
          version: p.version,
          digest: p.digest,
          appliesTo: p.record.appliesTo,
          factIds: p.factIds,
          traceId: recall.traceId,
        };
        kept.set(p.id, { precedent: p, citation });
      }
    }
  }
  const entries = [...kept.values()].sort((a, b) => a.citation.id.localeCompare(b.citation.id));
  return {
    basis: PrecedentBasis.parse({ citations: entries.map((e) => e.citation), epochs }),
    precedents: entries.map((e) => e.precedent),
    dropped: dropped.filter((d) => !kept.has(d.id)),
  };
}
