import {
  PrecedentBasis,
  type PrecedentCitation,
  PrecedentId,
  type PrecedentRecallArea,
  PrecedentRecallDiagnostics,
  type PrecedentRecallDrop,
  RECALL_DIAGNOSTICS_LIMITS,
} from "@rehearsal/contracts";
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
 *
 * `diagnostics` (T1.54) records, per area, the query recall was sent, what it found and what was
 * dropped at which stage, for the reviewer. It explains the basis and never changes it, and is
 * stored beside the plan, not in the manifest. Null only if it can't be fitted to the contract;
 * `log` hears about that and about anything cut to fit.
 */
export async function recallBasis(
  recaller: { recall(caseKey: string): Promise<PrecedentRecall> },
  registry: RegistrySnapshot,
  options: { log?: (line: string) => void } = {},
): Promise<{
  basis: PrecedentBasis;
  precedents: RecalledPrecedent[];
  dropped: { id: string; reason: string }[];
  diagnostics: PrecedentRecallDiagnostics | null;
} | null> {
  const areas = [...registry.epochs.keys()].sort();
  if (areas.length === 0) return null;
  const epochs = Object.fromEntries(areas.map((a) => [a, registry.epochs.get(a) ?? 0]));
  const kept = new Map<string, { precedent: RecalledPrecedent; citation: PrecedentCitation }>();
  const dropped: { id: string; reason: string }[] = [];
  const recalls: PrecedentRecallArea[] = [];
  // Nothing active means nothing to cite; the epochs alone still bind the plan.
  if (registry.active.size > 0) {
    for (const area of areas) {
      // The area key is the query recall is sent.
      const recall = await recaller.recall(area);
      const drops: PrecedentRecallDrop[] = recall.rejected.map((r) => ({
        id: r.id,
        reason: r.reason,
        stage: "recall",
      }));
      recalls.push({
        area,
        query: area,
        traceId: recall.traceId,
        hits: recall.precedents.map((p) => ({
          id: p.id,
          version: p.version,
          factIds: p.factIds,
          hitIds: p.hitIds,
        })),
        dropped: drops,
      });
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
          drops.push({ id: p.id, reason, stage: "registry" });
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
    diagnostics: capDiagnostics(registry.active.size > 0, recalls, {
      cited: new Set(entries.map((e) => `${e.citation.id}@${e.citation.version}`)),
      ...(options.log && { log: options.log }),
    }),
  };
}

const L = RECALL_DIAGNOSTICS_LIMITS;
const clip = (s: string, max: number = L.text) => s.slice(0, max);
const isPrecedentId = (id: string) => PrecedentId.safeParse(id).success;
const strings = (xs: readonly string[], max: number) =>
  xs
    .filter((x) => x.length > 0)
    .slice(0, max)
    .map((x) => clip(x));

/**
 * Most a plan's diagnostics may take serialized, well under the API's 1 MB body limit, so an
 * explain-only field can never make the completion fail.
 */
export const RECALL_DIAGNOSTICS_MAX_BYTES = 256 * 1024;

/**
 * Fits what recall returned to the contract's caps, so an oversized answer can't grow what is
 * stored with a plan. An entry it can't represent (an ID that isn't a precedent slug, an empty
 * string) is left out rather than failing the plan: diagnostics only explain. Past
 * `maxBytes` it drops every hit's hit IDs, then trailing hits that weren't cited, then trailing
 * areas, and logs what it cut.
 */
export function capDiagnostics(
  recalled: boolean,
  areas: readonly PrecedentRecallArea[],
  options: {
    /** `id@version` of each cited precedent, whose hits are the last to go. */
    cited?: ReadonlySet<string>;
    maxBytes?: number;
    log?: (line: string) => void;
  } = {},
): PrecedentRecallDiagnostics | null {
  const log = options.log ?? (() => {});
  const parsed = PrecedentRecallDiagnostics.safeParse({
    recalled,
    areas: areas.slice(0, L.areas).map((a) => ({
      area: clip(a.area),
      query: clip(a.query),
      traceId: a.traceId ? clip(a.traceId) : null,
      hits: a.hits
        .filter((h) => isPrecedentId(h.id))
        .slice(0, L.perArea)
        .map((h) => ({
          id: h.id,
          version: h.version,
          factIds: strings(h.factIds, L.factIds),
          hitIds: strings(h.hitIds, L.hitIds),
        })),
      dropped: a.dropped
        .filter((d) => isPrecedentId(d.id))
        .slice(0, L.perArea)
        .map((d) => ({
          id: d.id,
          reason: clip(d.reason, L.reason) || "no reason given",
          stage: d.stage,
        })),
    })),
  });
  if (!parsed.success) {
    log(`recall diagnostics left out: ${parsed.error.message.slice(0, 300)}`);
    return null;
  }
  return fitBudget(
    parsed.data,
    options.cited ?? new Set(),
    options.maxBytes ?? RECALL_DIAGNOSTICS_MAX_BYTES,
    log,
  );
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

function fitBudget(
  d: PrecedentRecallDiagnostics,
  cited: ReadonlySet<string>,
  maxBytes: number,
  log: (line: string) => void,
): PrecedentRecallDiagnostics {
  let total = bytes(d);
  if (total <= maxBytes) return d;
  const cut: string[] = [];
  const areas = d.areas.map((a) => ({ ...a, hits: a.hits.map((h) => ({ ...h, hitIds: [] })) }));
  total = bytes({ ...d, areas });
  cut.push("every hit ID");
  // Then trailing hits, from the last area back, keeping the ones the plan cites. Sizes are
  // subtracted as they go (the element and its comma), so this stays linear.
  let hits = 0;
  for (let i = areas.length - 1; i >= 0 && total > maxBytes; i--) {
    const area = areas[i];
    if (!area) continue;
    for (let j = area.hits.length - 1; j >= 0 && total > maxBytes; j--) {
      const h = area.hits[j];
      if (!h || cited.has(`${h.id}@${h.version}`)) continue;
      total -= bytes(h) + (area.hits.length > 1 ? 1 : 0);
      area.hits.splice(j, 1);
      hits++;
    }
  }
  if (hits > 0) cut.push(`${hits} trailing hit${hits === 1 ? "" : "s"}`);
  let dropped = 0;
  while (areas.length > 0 && bytes({ ...d, areas }) > maxBytes) {
    areas.pop();
    dropped++;
  }
  if (dropped > 0) cut.push(`${dropped} trailing area${dropped === 1 ? "" : "s"}`);
  log(`recall diagnostics over ${maxBytes} bytes: cut ${cut.join(", ")}`);
  return { recalled: d.recalled, areas };
}
