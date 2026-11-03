import { PrecedentBasis, PrecedentRecallDiagnostics } from "@rehearsal/contracts";
import { fingerprint } from "@rehearsal/core";
import { and, desc, eq, lte } from "drizzle-orm";
import type { Db } from "./index";
import { planRecallDiagnostics } from "./schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The basis a row of diagnostics explains, by content: the same citations and epochs. */
export function basisDigest(basis: PrecedentBasis): string {
  return fingerprint(PrecedentBasis.parse(basis));
}

/**
 * T1.54: records why each precedent was or wasn't recalled for one planned revision. Append-only:
 * the first row for a revision stays, so a repeated completion can't replace what was shown.
 * Returns false when the revision already had diagnostics.
 */
export async function recordRecallDiagnostics(
  db: Db | Tx,
  row: {
    orgId: string;
    planId: string;
    revision: number;
    planHash: string;
    basis: PrecedentBasis;
    diagnostics: PrecedentRecallDiagnostics;
  },
): Promise<boolean> {
  const diagnostics = PrecedentRecallDiagnostics.parse(row.diagnostics);
  const inserted = await db
    .insert(planRecallDiagnostics)
    .values({
      orgId: row.orgId,
      planId: row.planId,
      revision: row.revision,
      planHash: row.planHash,
      basisDigest: basisDigest(row.basis),
      diagnostics,
    })
    .onConflictDoNothing()
    .returning({ revision: planRecallDiagnostics.revision });
  return inserted.length > 0;
}

export interface StoredRecallDiagnostics {
  /** The revision whose planning recorded them; earlier than the one shown after a reviewer edit. */
  revision: number;
  recordedAt: string;
  diagnostics: PrecedentRecallDiagnostics;
}

/**
 * The diagnostics that explain `basis` at `revision`: the newest recorded at or before it, and only
 * while they explain exactly this basis (a reviewer's revision keeps its parent's basis; a repair
 * that recalled again doesn't). Null when none were recorded (a plan made before T1.54), when the
 * basis has changed since, or when the stored row doesn't parse.
 */
export async function loadRecallDiagnostics(
  db: Db | Tx,
  key: { orgId: string; planId: string; revision: number; basis: PrecedentBasis },
): Promise<StoredRecallDiagnostics | null> {
  const [row] = await db
    .select()
    .from(planRecallDiagnostics)
    .where(
      and(
        eq(planRecallDiagnostics.orgId, key.orgId),
        eq(planRecallDiagnostics.planId, key.planId),
        lte(planRecallDiagnostics.revision, key.revision),
      ),
    )
    .orderBy(desc(planRecallDiagnostics.revision))
    .limit(1);
  if (!row || row.basisDigest !== basisDigest(key.basis)) return null;
  const diagnostics = PrecedentRecallDiagnostics.safeParse(row.diagnostics);
  if (!diagnostics.success) return null;
  return {
    revision: row.revision,
    recordedAt: row.recordedAt.toISOString(),
    diagnostics: diagnostics.data,
  };
}
