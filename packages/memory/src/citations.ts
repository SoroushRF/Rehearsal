import type { PrecedentCitation } from "@rehearsal/contracts";
import type { PrecedentRecall } from "./precedents";

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
