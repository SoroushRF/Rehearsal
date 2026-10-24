import type { ApprovalGrant, Role, RunState } from "@rehearsal/contracts";
import type { ApplyStore, StoredRun } from "@rehearsal/core";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "./index";
import { approvalGrants, planVersions, runs } from "./schema";

export function toApprovalGrant(row: typeof approvalGrants.$inferSelect): ApprovalGrant {
  return {
    id: row.id,
    orgId: row.orgId,
    planId: row.planId,
    revision: row.revision,
    planHash: row.planHash,
    actorUserId: row.actorUserId,
    actorSessionId: row.actorSessionId,
    roles: row.roles as Role[],
    grantedAt: row.grantedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

/**
 * The executor's read access to runs, plans and grants, plus the per-plan apply lock. Every query
 * is scoped to the org passed in; nothing here trusts the job payload.
 */
export class PgApplyStore implements ApplyStore {
  constructor(private readonly db: Db) {}

  async loadRun(orgId: string, runId: string): Promise<StoredRun | null> {
    const [row] = await this.db
      .select()
      .from(runs)
      .where(and(eq(runs.orgId, orgId), eq(runs.id, runId)));
    return row
      ? {
          planId: row.planId,
          revision: row.revision,
          planHash: row.planHash,
          approvalId: row.approvalId,
        }
      : null;
  }

  async loadPlan(orgId: string, planId: string, revision: number) {
    const [row] = await this.db
      .select({ planHash: planVersions.planHash, manifest: planVersions.manifest })
      .from(planVersions)
      .where(
        and(
          eq(planVersions.orgId, orgId),
          eq(planVersions.planId, planId),
          eq(planVersions.revision, revision),
        ),
      );
    return row ?? null;
  }

  async loadGrant(orgId: string, approvalId: string): Promise<ApprovalGrant | null> {
    const [row] = await this.db
      .select()
      .from(approvalGrants)
      .where(and(eq(approvalGrants.orgId, orgId), eq(approvalGrants.id, approvalId)));
    return row ? toApprovalGrant(row) : null;
  }

  async loadGrantsForPlanHash(orgId: string, planHash: string): Promise<ApprovalGrant[]> {
    const rows = await this.db
      .select()
      .from(approvalGrants)
      .where(and(eq(approvalGrants.orgId, orgId), eq(approvalGrants.planHash, planHash)));
    return rows.map(toApprovalGrant);
  }

  /**
   * Session-level advisory lock on (org, plan), held on its own pooled connection for the whole
   * run. If the worker dies, Postgres drops the connection and the lock with it.
   */
  async lockPlan(orgId: string, planId: string): Promise<(() => Promise<void>) | null> {
    const key = `rehearsal:apply:${orgId}:${planId}`;
    const client = await this.db.$client.connect();
    // Without a listener, a dropped lock connection is an unhandled 'error' that kills the worker.
    // Postgres has then released the lock; the run's own journal writes fail if the DB is gone.
    // The listener is removed before the client goes back to the pool, so none pile up.
    const onError = (err: Error) => {
      console.error(`apply lock connection for ${planId} lost: ${err.message}`);
    };
    client.on("error", onError);
    const giveBack = (err?: Error) => {
      client.off("error", onError);
      client.release(err);
    };
    try {
      const { rows } = await client.query<{ ok: boolean }>(
        "select pg_try_advisory_lock(hashtextextended($1, 0)) as ok",
        [key],
      );
      if (!rows[0]?.ok) {
        giveBack();
        return null;
      }
    } catch (err) {
      giveBack(err as Error);
      throw err;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]);
        giveBack();
      } catch (err) {
        // A broken connection already dropped the lock; discard it rather than reuse it.
        giveBack(err as Error);
      }
    };
  }

  async runCancelled(orgId: string, runId: string): Promise<boolean> {
    return (await this.runState(orgId, runId)) === "cancelled";
  }

  async runState(orgId: string, runId: string): Promise<RunState | null> {
    const [row] = await this.db
      .select({ state: runs.state })
      .from(runs)
      .where(and(eq(runs.orgId, orgId), eq(runs.id, runId)));
    return (row?.state as RunState | undefined) ?? null;
  }

  /**
   * Compare-and-set on a run's state: moves it to `to` only if it is currently one of `from`.
   * Returns whether it moved. A stale or duplicate job therefore can't revive a finished or
   * cancelled run, or collide with a newer active run of the same hash.
   */
  async transitionRun(
    orgId: string,
    runId: string,
    from: readonly RunState[],
    to: RunState,
  ): Promise<boolean> {
    const moved = await this.db
      .update(runs)
      .set({ state: to, updatedAt: new Date() })
      .where(and(eq(runs.orgId, orgId), eq(runs.id, runId), inArray(runs.state, [...from])))
      .returning({ id: runs.id });
    return moved.length > 0;
  }

  /** Unconditional; for operators and tests. The worker uses transitionRun. */
  async setRunState(orgId: string, runId: string, state: RunState): Promise<void> {
    await this.db
      .update(runs)
      .set({ state, updatedAt: new Date() })
      .where(and(eq(runs.orgId, orgId), eq(runs.id, runId)));
  }
}
