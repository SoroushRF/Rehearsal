import { randomUUID } from "node:crypto";
import { planHash as computePlanHash } from "@rehearsal/core";
import { and, desc, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Db } from "./index";
import { enqueueApply } from "./queue";
import { approvalGrants, planVersions, runs } from "./schema";

export interface ApplyCommand {
  orgId: string;
  userId: string;
  planId: string;
  revision: number;
  planHash: string;
  now: Date;
}

export type ApplyResult =
  | { kind: "accepted"; runId: string; state: string; existing: boolean }
  | { kind: "not_found" }
  | { kind: "hash_mismatch"; detail: string }
  | { kind: "approval_invalid"; detail: string };

/** A request for a hash with one of these runs returns that run instead of starting another. */
const REUSABLE_STATES = ["approved", "applying", "completed"];

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
    const manifest = plan.manifest as { orgId?: unknown; planId?: unknown; revision?: unknown };
    if (
      manifest.orgId !== cmd.orgId ||
      manifest.planId !== cmd.planId ||
      manifest.revision !== cmd.revision ||
      computePlanHash(plan.manifest) !== plan.planHash
    ) {
      return { kind: "hash_mismatch", detail: "stored manifest does not match its row or hash" };
    }

    const findReusable = () =>
      tx
        .select({ id: runs.id, state: runs.state })
        .from(runs)
        .where(
          and(
            eq(runs.orgId, cmd.orgId),
            eq(runs.planHash, cmd.planHash),
            inArray(runs.state, REUSABLE_STATES),
          ),
        )
        .orderBy(desc(runs.createdAt))
        .limit(1);

    // Idempotent: a repeat click returns the active or finished run, whatever the grant now says.
    const [reusable] = await findReusable();
    if (reusable)
      return { kind: "accepted", runId: reusable.id, state: reusable.state, existing: true };

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
          lte(approvalGrants.grantedAt, cmd.now),
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
        requestedBy: cmd.userId,
        state: "approved",
      })
      .onConflictDoNothing()
      .returning({ id: runs.id });

    if (!inserted) {
      // A concurrent request created the active run first.
      const [existing] = await findReusable();
      if (!existing) throw new Error("run conflict without an active run");
      return { kind: "accepted", runId: existing.id, state: existing.state, existing: true };
    }

    await enqueueApply(boss, tx, {
      orgId: cmd.orgId,
      runId,
      planId: cmd.planId,
      revision: cmd.revision,
      planHash: cmd.planHash,
    });
    return { kind: "accepted", runId, state: "approved", existing: false };
  });
}
