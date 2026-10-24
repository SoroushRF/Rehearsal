import type { PlanManifest } from "@rehearsal/contracts";
import { type Db, schema } from "@rehearsal/db";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AuthResolver } from "./apply";
import { loadPlan } from "./plans";

const { runs, approvalGrants, stepAttempts, stepReceipts } = schema;

export interface AuditDeps {
  db: Db;
  auth: AuthResolver;
}

type RunRow = typeof runs.$inferSelect;
type GrantRow = typeof approvalGrants.$inferSelect;
type AttemptRow = typeof stepAttempts.$inferSelect;
type ReceiptRow = typeof stepReceipts.$inferSelect;

export interface AuditInput {
  run: RunRow;
  plan: { planId: string; revision: number; planHash: string; manifest: PlanManifest };
  /** Every grant ever made for this plan hash, including expired and revoked ones. */
  grants: GrantRow[];
  attempts: AttemptRow[];
  receipts: ReceiptRow[];
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

/**
 * What was approved and what happened, from stored rows only. The policy comes from the snapshot
 * kept on the grant the run used, never from the policy files loaded now, and nothing is read
 * from a provider, so changing either afterwards cannot change what an old run shows.
 */
export function buildAudit({ run, plan, grants, attempts, receipts }: AuditInput) {
  const used = grants.find((g) => g.id === run.approvalId) ?? null;
  return {
    source: "stored_history" as const,
    run: {
      id: run.id,
      planId: run.planId,
      revision: run.revision,
      planHash: run.planHash,
      approvalId: run.approvalId,
      requestedBy: run.requestedBy,
      state: run.state,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
    },
    plan,
    /**
     * One entry per policy the plan cites. `contents` is null when the grant that approved it
     * predates snapshots (or is gone), which the UI must say rather than show today's file.
     */
    policies: plan.manifest.policies.map((ref) => ({
      ...ref,
      contents:
        used?.policies?.find((p) => p.id === ref.id && p.version === ref.version)?.contents ?? null,
    })),
    grants: grants.map((g) => ({
      id: g.id,
      actorUserId: g.actorUserId,
      actorSessionId: g.actorSessionId,
      roles: g.roles,
      grantedAt: g.grantedAt.toISOString(),
      expiresAt: g.expiresAt.toISOString(),
      revokedAt: iso(g.revokedAt),
      usedByRun: g.id === run.approvalId,
    })),
    attempts: attempts.map((a) => ({
      id: a.id,
      actionId: a.actionId,
      operationKey: a.operationKey,
      attemptNo: a.attemptNo,
      state: a.state,
      request: a.request,
      providerStatus: a.providerStatus,
      error: a.error,
      preparedAt: a.preparedAt.toISOString(),
      dispatchedAt: iso(a.dispatchedAt),
      settledAt: iso(a.settledAt),
    })),
    receipts: receipts.map((r) => ({
      id: r.id,
      actionId: r.actionId,
      recordedAt: r.recordedAt.toISOString(),
      receipt: r.receipt,
    })),
  };
}

/** Read-only: the audit of a past run, assembled from append-only history. */
export function registerAuditRoute(app: FastifyInstance, deps: AuditDeps) {
  app.get<{ Params: { id: string } }>("/api/runs/:id/audit", async (req, reply) => {
    const auth = await deps.auth(req);
    if (!auth) return reply.code(401).send({ error: "unauthenticated" });

    const [run] = await deps.db
      .select()
      .from(runs)
      .where(and(eq(runs.orgId, auth.orgId), eq(runs.id, req.params.id)));
    if (!run) return reply.code(404).send({ error: "run_not_found" });

    // Re-verified against its own hash: a row that doesn't match is never shown as approved.
    const loaded = await loadPlan(deps.db, auth.orgId, run.planId, run.revision);
    if (loaded.kind === "not_found") return reply.code(404).send({ error: "plan_not_found" });
    if (loaded.kind === "corrupt" || loaded.plan.planHash !== run.planHash) {
      req.log.error({ runId: run.id }, "stored plan does not match the run's hash");
      return reply.code(500).send({ error: "stored_plan_invalid" });
    }

    const [grants, attempts, receipts] = await Promise.all([
      deps.db
        .select()
        .from(approvalGrants)
        .where(and(eq(approvalGrants.orgId, auth.orgId), eq(approvalGrants.planHash, run.planHash)))
        .orderBy(asc(approvalGrants.grantedAt)),
      deps.db
        .select()
        .from(stepAttempts)
        .where(and(eq(stepAttempts.orgId, auth.orgId), eq(stepAttempts.planHash, run.planHash)))
        .orderBy(asc(stepAttempts.preparedAt), asc(stepAttempts.attemptNo)),
      deps.db
        .select()
        .from(stepReceipts)
        .where(and(eq(stepReceipts.orgId, auth.orgId), eq(stepReceipts.planHash, run.planHash)))
        .orderBy(asc(stepReceipts.recordedAt)),
    ]);
    return buildAudit({ run, plan: loaded.plan, grants, attempts, receipts });
  });
}
