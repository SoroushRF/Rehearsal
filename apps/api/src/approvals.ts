import { randomUUID } from "node:crypto";
import { ApprovalGrant, ApproveRequest } from "@rehearsal/contracts";
import {
  type ApprovalStatus,
  approvalStatus,
  type BillingPolicy,
  evaluateBillingPolicy,
  validateGraph,
} from "@rehearsal/core";
import { type Db, schema, toApprovalGrant } from "@rehearsal/db";
import { and, desc, eq, gt, isNull, lte } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  AUTHZ_RULE,
  approvalFacts,
  authorize,
  bearerToken,
  type IamClient,
  refuse,
  requirePerson,
  rolesFromPermissions,
} from "./iam";
import { loadPlan, loadPlanById, type Outcome, type StoredPlan, type Tx } from "./plans";
import { precedentCheck } from "./precedent-check";

const { approvalGrants } = schema;

/** How long an approval stays usable for apply. Approval and apply are meant to be minutes apart. */
export const DEFAULT_APPROVAL_TTL_MS = 60 * 60 * 1000;

export interface ApprovalDeps {
  db: Db;
  iam?: IamClient;
  policies: readonly BillingPolicy[];
  now?: () => Date;
  ttlMs?: number;
}

type GrantRow = typeof approvalGrants.$inferSelect;

function toGrant(row: GrantRow): ApprovalGrant {
  return ApprovalGrant.parse(toApprovalGrant(row));
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
 * Approval binds one person's permissions to one exact revision and hash, for a limited time.
 * IAM decides whether they may sign. Hash, revision, and policy stay here. Dollars never leave.
 */
export function registerApprovalRoutes(app: FastifyInstance, deps: ApprovalDeps) {
  const now = () => deps.now?.() ?? new Date();

  app.post<{ Params: { id: string } }>("/api/plans/:id/approvals", async (req, reply) => {
    const token = bearerToken(req);
    if (!token) return reply.code(401).send({ error: "unauthenticated" });
    // Strict: the reviewer approves a stored revision by number and hash, never a body of actions.
    const body = ApproveRequest.strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });

    const preview = await loadPlanById(deps.db, req.params.id, body.data.revision);
    if (preview.kind === "not_found") {
      const person = await requirePerson(deps.iam, token);
      if (!person.ok) return refuse(reply, person, "plan_not_found");
      return reply.code(404).send({ error: "plan_not_found" });
    }
    const orgId = preview.kind === "corrupt" ? preview.orgId : preview.plan.manifest.orgId;
    const resource =
      preview.kind === "found"
        ? { orgId, ...approvalFacts(preview.plan.manifest, deps.policies) }
        : { orgId };
    const gate = await authorize(deps.iam, token, "POST /api/plans/:id/approvals", resource);
    if (!gate.ok) return refuse(reply, gate, "plan_not_found");
    if (preview.kind === "corrupt") {
      req.log.error({ planId: req.params.id }, preview.detail);
      return reply.code(500).send({ error: "stored_plan_invalid" });
    }
    const roles = rolesFromPermissions(gate.person.permissions);
    if (roles.length === 0) return reply.code(403).send({ error: "forbidden" });

    // Reply only after the transaction commits, so an apply right after a 201 finds the grant.
    const out = await deps.db.transaction(async (tx): Promise<Outcome> => {
      const loaded = await loadPlan(tx, orgId, req.params.id, body.data.revision);
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

      // A precedent the plan rested on may have been replaced or withdrawn since it was planned.
      const precedents = await precedentCheck(tx, plan.manifest);
      if (!precedents.ok) {
        return [409, { error: "precedent_changed", holds: precedents.holds }];
      }

      const at = now();
      // A repeat click returns this person's live grant for this hash instead of stacking another.
      const [live] = await tx
        .select()
        .from(approvalGrants)
        .where(
          and(
            eq(approvalGrants.orgId, plan.manifest.orgId),
            eq(approvalGrants.planHash, plan.planHash),
            eq(approvalGrants.actorUserId, gate.person.userId),
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
        orgId: plan.manifest.orgId,
        planId: plan.planId,
        revision: plan.revision,
        planHash: plan.planHash,
        actorUserId: gate.person.userId,
        actorSessionId: gate.person.sessionId,
        roles,
        permissions: gate.person.permissions,
        authzRule: AUTHZ_RULE,
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
    const token = bearerToken(req);
    if (!token) return reply.code(401).send({ error: "unauthenticated" });
    const loaded = await loadPlanById(deps.db, req.params.id);
    if (loaded.kind === "not_found") {
      const person = await requirePerson(deps.iam, token);
      if (!person.ok) return refuse(reply, person, "plan_not_found");
      return reply.code(404).send({ error: "plan_not_found" });
    }
    const orgId = loaded.kind === "corrupt" ? loaded.orgId : loaded.plan.manifest.orgId;
    const gate = await authorize(deps.iam, token, "GET /api/plans/:id/approvals", { orgId });
    if (!gate.ok) return refuse(reply, gate, "plan_not_found");
    if (loaded.kind === "corrupt") {
      req.log.error({ planId: req.params.id }, loaded.detail);
      return reply.code(500).send({ error: "stored_plan_invalid" });
    }

    const rows = await deps.db
      .select()
      .from(approvalGrants)
      .where(and(eq(approvalGrants.orgId, orgId), eq(approvalGrants.planId, req.params.id)))
      .orderBy(desc(approvalGrants.grantedAt));
    const at = now().getTime();
    const approval = await statusFor(deps.db, deps, loaded.plan, now());
    const precedents = await precedentCheck(deps.db, loaded.plan.manifest);
    return {
      grants: rows.map((r) => ({
        ...toGrant(r),
        live: r.revokedAt === null && r.grantedAt.getTime() <= at && r.expiresAt.getTime() > at,
      })),
      approval,
      precedents,
    };
  });

  /** Withdraws an approval. Revocation only ever sets `revokedAt` once; nothing else changes. */
  app.post<{ Params: { id: string; grantId: string } }>(
    "/api/plans/:id/approvals/:grantId/revoke",
    async (req, reply) => {
      const token = bearerToken(req);
      if (!token) return reply.code(401).send({ error: "unauthenticated" });

      const [grant] = await deps.db
        .select()
        .from(approvalGrants)
        .where(eq(approvalGrants.id, req.params.grantId));
      if (!grant || grant.planId !== req.params.id) {
        const person = await requirePerson(deps.iam, token);
        if (!person.ok) return refuse(reply, person, "grant_not_found");
        return reply.code(404).send({ error: "grant_not_found" });
      }
      const gate = await authorize(
        deps.iam,
        token,
        "POST /api/plans/:id/approvals/:grantId/revoke",
        {
          orgId: grant.orgId,
          grant: { actorUserId: grant.actorUserId },
        },
      );
      if (!gate.ok) return refuse(reply, gate, "grant_not_found");

      const scope = and(
        eq(approvalGrants.orgId, grant.orgId),
        eq(approvalGrants.planId, grant.planId),
        eq(approvalGrants.id, grant.id),
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
