import type { PlanManifest } from "@rehearsal/contracts";
import { CHALLENGE_CATALOG, CHALLENGE_CATALOG_VERSION, resolveScenario } from "@rehearsal/core";
import { happyPathBundle } from "./bundles";

/**
 * T4.11 fixtures: every published scenario bound to the happy-path plan. Evidence is `fixture`.
 * T2's report, T3's lifecycle tests and T4.12's verifier build against these before a run on Era.
 */
export function rehearsalChallengeFixtures(manifest: PlanManifest = happyPathBundle().manifest) {
  return CHALLENGE_CATALOG.map((definition) => {
    const resolved = resolveScenario(manifest, {
      id: definition.id,
      version: CHALLENGE_CATALOG_VERSION,
    });
    if (!resolved.ok) throw new Error(`${definition.id}: ${resolved.reason}`);
    return resolved.scenario;
  });
}
