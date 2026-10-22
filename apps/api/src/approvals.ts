import { randomUUID } from "node:crypto";
import { ApprovalGrant, ApproveRequest } from "@rehearsal/contracts";
import { type BillingPolicyV1, evaluateBillingPolicy, validateGraph } from "@rehearsal/core";
import { type Db, schema } from "@rehearsal/db";
import { and, desc, eq, gt, isNull, lte } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ReviewerResolver } from "./auth";
import { loadPlan } from "./plans";

const { approvalGrants } = schema;

/** How long an approval stays usable for apply. Approval and apply are meant to be minutes apart. */
export const DEFAULT_APPROVAL_TTL_MS = 60 * 60 * 1000;

export interface ApprovalDeps {
  db: Db;
  reviewer: ReviewerResolver;
  policies: readonly BillingPolicyV1[];
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

    return deps.db.transaction(async (tx) => {
      const loaded = await loadPlan(tx, me.orgId, req.params.id, body.data.revision);
      if (loaded.kind === "not_found") return reply.code(404).send({ error: "plan_not_found" });
      if (loaded.kind === "corrupt") {
        req.log.error({ planId: req.params.id }, loaded.detail);
        return reply.code(500).send({ error: "stored_plan_invalid" });
      }
      const { plan, latestRevision } = loaded;
      if (plan.planHash !== body.data.planHash) {
        return reply.code(409).send({ error: "hash_mismatch" });
      }
      if (plan.revision !== latestRevision) {
        return reply.code(409).send({ error: "stale_revision", latestRevision });
      }

      if (plan.manifest.actions.length === 0) {
        return reply.code(422).send({ error: "empty_plan" });
      }
      const graph = validateGraph(plan.manifest.actions);
      if (graph.length > 0) return reply.code(422).send({ error: "invalid_graph", issues: graph });
      for (const ref of plan.manifest.policies) {
        const policy = deps.policies.find((p) => p.id === ref.id && p.version === ref.version);
        if (!policy) return reply.code(422).send({ error: "unknown_policy", policy: ref });
        const { violations } = evaluateBillingPolicy(plan.manifest, policy);
        if (violations.length > 0) {
          return reply.code(422).send({ error: "policy_violation", violations });
        }
      }

      const required = [...new Set(plan.manifest.actions.map((a) => a.requiredRole))];
      const missing = required.filter((r) => !me.roles.includes(r));
      if (missing.length > 0) {
        return reply.code(403).send({ error: "missing_roles", missing, held: me.roles });
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
      if (live) return reply.code(200).send({ grant: toGrant(live), existing: true });

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
      });
      return reply.code(201).send({ grant, existing: false });
    });
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
    return {
      grants: rows.map((r) => ({
        ...toGrant(r),
        live: r.revokedAt === null && r.grantedAt.getTime() <= at && r.expiresAt.getTime() > at,
      })),
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
