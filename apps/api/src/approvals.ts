import { randomUUID } from "node:crypto";
import { ApprovalGrant, ApproveRequest } from "@rehearsal/contracts";
import {
  type ApprovalStatus,
  approvalStatus,
  type BillingPolicy,
  evaluateBillingPolicy,
  requiresDualApproval,
  validateGraph,
} from "@rehearsal/core";
import { type Db, schema, toApprovalGrant } from "@rehearsal/db";
import { and, desc, eq, gt, isNull, lte } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ReviewerResolver } from "./auth";
import { loadPlan, type Outcome, type StoredPlan, type Tx } from "./plans";

const { approvalGrants } = schema;

/** How long an approval stays usable for apply. Approval and apply are meant to be minutes apart. */
export const DEFAULT_APPROVAL_TTL_MS = 60 * 60 * 1000;

export interface ApprovalDeps {
  db: Db;
  reviewer: ReviewerResolver;
  policies: readonly BillingPolicy[];
  now?: () => Date;
  ttlMs?: number;
}

type GrantRow = typeof approvalGrants.$inferSelect;

function toGrant(row: GrantRow): ApprovalGrant {
  return ApprovalGrant.parse({
    ...row,
    grantedAt: row.grantedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  });
}

/** Who has signed which seat, and which is open, from the stored grants for this exact hash. */
async function statusFor(
  db: Db | Tx,
  deps: ApprovalDeps,
  plan: StoredPlan,
  at: Date,
): Promise<ApprovalStatus> {
  const rows = await db
    .select()
    .from(approvalGrants)
    .where(
      and(
        eq(approvalGrants.orgId, plan.manifest.orgId),
        eq(approvalGrants.planHash, plan.planHash),
      ),
    );
  return approvalStatus(plan.manifest, plan.planHash, deps.policies, rows.map(toApprovalGrant), at);
}

/**
 * Approval binds one reviewer's verified roles to one exact revision and hash, for a limited time.
 * It checks everything executor admission will check (graph, policy, roles), so a plan that would
 * be refused at apply is refused here first. Admission re-checks all of it regardless.
 */
export function registerApprovalRoutes(app: FastifyInstance, deps: ApprovalDeps) {
  const now = () => deps.now?.() ?? new Date();

  app.post<{ Params: { id: string } }>("/api/plans/:id/approvals", async (req, reply) => {
    const me = await deps.reviewer(req);
    if (!me) return reply.code(401).send({ error: "unauthenticated" });
    if (me.roles.length === 0) {
      return reply.code(403).send({ error: "missing_roles", missing: [], held: [] });
    }
    // Strict: the reviewer approves a stored revision by number and hash, never a body of actions.
    const body = ApproveRequest.strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });

    // Reply only after the transaction commits, so an apply right after a 201 finds the grant.
    const out = await deps.db.transaction(async (tx): Promise<Outcome> => {
      const loaded = await loadPlan(tx, me.orgId, req.params.id, body.data.revision);
      if (loaded.kind === "not_found") return [404, { error: "plan_not_found" }];
      if (loaded.kind === "corrupt") {
        req.log.error({ planId: req.params.id }, loaded.detail);
        return [500, { error: "stored_plan_invalid" }];
      }
      const { plan, latestRevision } = loaded;
      if (plan.planHash !== body.data.planHash) {
        return [409, { error: "hash_mismatch" }];
      }
      if (plan.revision !== latestRevision) {
        return [409, { error: "stale_revision", latestRevision }];
      }

      if (plan.manifest.actions.length === 0) {
        return [422, { error: "empty_plan" }];
      }
      const graph = validateGraph(plan.manifest.actions);
      if (graph.length > 0) return [422, { error: "invalid_graph", issues: graph }];
      const policySnapshot: { id: string; version: number; contents: unknown }[] = [];
      for (const ref of plan.manifest.policies) {
        const policy = deps.policies.find((p) => p.id === ref.id && p.version === ref.version);
        if (!policy) return [422, { error: "unknown_policy", policy: ref }];
        const { violations } = evaluateBillingPolicy(plan.manifest, policy);
        if (violations.length > 0) {
          return [422, { error: "policy_violation", violations }];
        }
        policySnapshot.push({ id: ref.id, version: ref.version, contents: policy });
      }

      // Where policy asks for two approvers (decision 0011) each signs for their own seat, so a
      // member holding either role may sign; admission then needs two different people.
      if (!requiresDualApproval(plan.manifest, deps.policies)) {
        const required = [...new Set(plan.manifest.actions.map((a) => a.requiredRole))];
        const missing = required.filter((r) => !me.roles.includes(r));
        if (missing.length > 0) {
          return [403, { error: "missing_roles", missing, held: me.roles }];
        }
      }

      const at = now();
      // A repeat click returns the reviewer's live grant for this hash instead of stacking another.
      const [live] = await tx
        .select()
        .from(approvalGrants)
        .where(
          and(
            eq(approvalGrants.orgId, me.orgId),
            eq(approvalGrants.planHash, plan.planHash),
            eq(approvalGrants.actorUserId, me.userId),
            isNull(approvalGrants.revokedAt),
            lte(approvalGrants.grantedAt, at),
            gt(approvalGrants.expiresAt, at),
          ),
        )
        .orderBy(desc(approvalGrants.grantedAt))
        .limit(1);
      if (live) {
        const approval = await statusFor(tx, deps, plan, at);
        return [200, { grant: toGrant(live), existing: true, approval }];
      }

      const grant = ApprovalGrant.parse({
        id: `grant_${randomUUID()}`,
        orgId: me.orgId,
        planId: plan.planId,
        revision: plan.revision,
        planHash: plan.planHash,
        actorUserId: me.userId,
        actorSessionId: me.sessionId,
        roles: me.roles,
        grantedAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + (deps.ttlMs ?? DEFAULT_APPROVAL_TTL_MS)).toISOString(),
        revokedAt: null,
      });
      await tx.insert(approvalGrants).values({
        ...grant,
        grantedAt: new Date(grant.grantedAt),
        expiresAt: new Date(grant.expiresAt),
        revokedAt: null,
        policies: policySnapshot,
      });
      const approval = await statusFor(tx, deps, plan, at);
      return [201, { grant, existing: false, approval }];
    });
    return reply.code(out[0]).send(out[1]);
  });

  app.get<{ Params: { id: string } }>("/api/plans/:id/approvals", async (req, reply) => {
    const me = await deps.reviewer(req);
    if (!me) return reply.code(401).send({ error: "unauthenticated" });
    const rows = await deps.db
      .select()
      .from(approvalGrants)
      .where(and(eq(approvalGrants.orgId, me.orgId), eq(approvalGrants.planId, req.params.id)))
      .orderBy(desc(approvalGrants.grantedAt));
    const at = now().getTime();
    // For the newest revision: is a second approver asked for, and who has signed which seat.
    const loaded = await loadPlan(deps.db, me.orgId, req.params.id);
    const approval =
      loaded.kind === "found" ? await statusFor(deps.db, deps, loaded.plan, now()) : null;
    return {
      grants: rows.map((r) => ({
        ...toGrant(r),
        live: r.revokedAt === null && r.grantedAt.getTime() <= at && r.expiresAt.getTime() > at,
      })),
      approval,
    };
  });

  /** Withdraws an approval. Revocation only ever sets `revokedAt` once; nothing else changes. */
  app.post<{ Params: { id: string; grantId: string } }>(
    "/api/plans/:id/approvals/:grantId/revoke",
    async (req, reply) => {
      const me = await deps.reviewer(req);
      if (!me) return reply.code(401).send({ error: "unauthenticated" });
      // Anyone who may approve in this org may withdraw an approval; read-only members may not.
      if (me.roles.length === 0) return reply.code(403).send({ error: "missing_roles" });

      const scope = and(
        eq(approvalGrants.orgId, me.orgId),
        eq(approvalGrants.planId, req.params.id),
        eq(approvalGrants.id, req.params.grantId),
      );
      const [revoked] = await deps.db
        .update(approvalGrants)
        .set({ revokedAt: now() })
        .where(and(scope, isNull(approvalGrants.revokedAt)))
        .returning();
      if (revoked) return { grant: toGrant(revoked), existing: false };

      const [already] = await deps.db.select().from(approvalGrants).where(scope);
      if (!already) return reply.code(404).send({ error: "grant_not_found" });
      return { grant: toGrant(already), existing: true };
    },
  );
}
