import { ReplayBundle, Sha256Hex } from "@rehearsal/contracts";
import { z } from "zod";

/**
 * The shared fixture bundles in `scenarios/billing/cases`, as written by `pnpm fixtures:write`.
 * Their plan hash was computed by `@rehearsal/core` when they were written; the browser shows it
 * and never re-derives it. Real plans replace these once `GET /api/plans/:id` lands (T2.2).
 */
const BundleFile = z.object({ planHash: Sha256Hex, bundle: ReplayBundle });
export type FixtureBundle = z.infer<typeof BundleFile>;

const files = import.meta.glob("../../../scenarios/billing/cases/*.bundle.json", {
  eager: true,
  import: "default",
});

/** Parses at load so a drifted fixture fails loudly instead of rendering half a plan. */
export const fixtureBundles: FixtureBundle[] = Object.entries(files)
  .map(([path, json]) => {
    const parsed = BundleFile.safeParse(json);
    if (!parsed.success) throw new Error(`invalid fixture bundle ${path}: ${parsed.error.message}`);
    return parsed.data;
  })
  .sort((a, b) => order(a.bundle.id) - order(b.bundle.id));

/** Demo order: the happy path first, then the hero moments. */
function order(id: string) {
  const i = ["happy-path", "phantom", "teammate-conflict", "unknown-outcome"].indexOf(id);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}
