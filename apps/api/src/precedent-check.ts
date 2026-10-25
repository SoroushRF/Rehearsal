import type { PlanManifest } from "@rehearsal/contracts";
import { type Db, loadRegistry } from "@rehearsal/db";
import { checkPrecedentBasis, type PrecedentHold } from "@rehearsal/memory";

export type PrecedentCheck = { ok: true } | { ok: false; holds: PrecedentHold[] };

/**
 * Whether the precedents a plan rests on still hold, decided from the registry in Postgres alone
 * (never from Agent Memory's recall). A plan that cited none always passes. This is what keeps a
 * reviewer from approving a plan whose precedent was replaced or withdrawn after planning; the
 * executor must check the same at admission (#234).
 */
export async function precedentCheck(
  db: Db | Parameters<Parameters<Db["transaction"]>[0]>[0],
  manifest: Pick<PlanManifest, "orgId" | "precedentBasis">,
): Promise<PrecedentCheck> {
  if (!manifest.precedentBasis) return { ok: true };
  const { snapshot } = await loadRegistry(db, manifest.orgId);
  return checkPrecedentBasis(manifest.precedentBasis, snapshot);
}
