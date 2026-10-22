import { randomUUID } from "node:crypto";
import { planHash as computePlanHash } from "@rehearsal/core";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Db } from "./index";
import { enqueueApply } from "./queue";
import { approvalGrants, planVersions, runs } from "./schema";

export interface ApplyCommand {
  orgId: string;
  planId: string;
  revision: number;
  planHash: string;
  now: Date;
}

export type ApplyResult =
  | { kind: "accepted"; runId: string; existing: boolean }
  | { kind: "not_found" }
  | { kind: "hash_mismatch"; detail: string }
  | { kind: "approval_invalid"; detail: string };

/**
 * Turns an apply request into a run plus an `apply` job, or refuses. It only checks what can be
 * checked at request time: the stored revision, its hash, and a live grant for that exact hash.
 * The executor re-checks all of this at admission before dispatching anything.
 */
export async function requestApply(db: Db, boss: PgBoss, cmd: ApplyCommand): Promise<ApplyResult> {
  return db.transaction(async (tx) => {
    const [plan] = await tx
      .select()
      .from(planVersions)
      .where(
        and(
          eq(planVersions.orgId, cmd.orgId),
          eq(planVersions.planId, cmd.planId),
          eq(planVersions.revision, cmd.revision),
        ),
      );
    if (!plan) return { kind: "not_found" };
    if (plan.planHash !== cmd.planHash) {
      return { kind: "hash_mismatch", detail: "request hash does not match the stored revision" };
    }
    if (computePlanHash(plan.manifest) !== plan.planHash) {
      return {
        kind: "hash_mismatch",
        detail: "stored manifest does not hash to its recorded hash",
      };
    }

    const [grant] = await tx
      .select({ id: approvalGrants.id })
      .from(approvalGrants)
      .where(
        and(
          eq(approvalGrants.orgId, cmd.orgId),
          eq(approvalGrants.planId, cmd.planId),
          eq(approvalGrants.revision, cmd.revision),
          eq(approvalGrants.planHash, cmd.planHash),
          isNull(approvalGrants.revokedAt),
          gt(approvalGrants.expiresAt, cmd.now),
        ),
      )
      .orderBy(desc(approvalGrants.grantedAt))
      .limit(1);
    if (!grant) {
      return { kind: "approval_invalid", detail: "no live approval grant for this exact hash" };
    }

    const runId = `run_${randomUUID()}`;
    const [inserted] = await tx
      .insert(runs)
      .values({
        id: runId,
        orgId: cmd.orgId,
        planId: cmd.planId,
        revision: cmd.revision,
        planHash: cmd.planHash,
        approvalId: grant.id,
        state: "approved",
      })
      .onConflictDoNothing()
      .returning({ id: runs.id });

    if (!inserted) {
      const [existing] = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.orgId, cmd.orgId), eq(runs.planHash, cmd.planHash)));
      if (!existing) throw new Error("run conflict without an existing run");
      return { kind: "accepted", runId: existing.id, existing: true };
    }

    await enqueueApply(boss, tx, {
      orgId: cmd.orgId,
      runId,
      planId: cmd.planId,
      revision: cmd.revision,
      planHash: cmd.planHash,
    });
    return { kind: "accepted", runId, existing: false };
  });
}
