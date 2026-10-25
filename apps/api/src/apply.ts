import { ApplyRequest, PlanManifest } from "@rehearsal/contracts";
import { approvalStatus, type BillingPolicy, explainShortfall } from "@rehearsal/core";
import { type Db, type PgBoss, requestApply, schema, toApprovalGrant } from "@rehearsal/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  approvalFacts,
  authorize,
  authorizeGrants,
  bearerToken,
  grantFact,
  type IamClient,
  refuse,
  requirePerson,
} from "./iam";
import { loadPlanById } from "./plans";

const { runs, approvalGrants } = schema;

/** States a repeat click returns instead of starting another run. `held` is absent so a resume can. */
const REUSABLE_STATES = ["approved", "applying", "completed", "cancelled"];

export interface ApplyDeps {
  db: Db;
  boss: PgBoss;
  iam?: IamClient;
  now?: () => Date;
  /** The policies approvals are checked against; with them, apply refuses a plan short of its approvers. */
  policies?: readonly BillingPolicy[];
}

/**
 * `POST /api/plans/:id/apply` names a stored revision and its hash; the browser never sends action
 * bodies. The person needs `rehearsal:apply:plan`. Queueing also needs `run:admit` on the stored
 * grants. A grant that only has roles is not admitted.
 */
export function registerApplyRoute(app: FastifyInstance, deps: ApplyDeps) {
  app.post<{ Params: { id: string } }>("/api/plans/:id/apply", async (req, reply) => {
    const token = bearerToken(req);
    if (!token) return reply.code(401).send({ error: "unauthenticated" });

    // Strict: a body carrying anything besides the revision and hash (e.g. actions) is refused.
    const body = ApplyRequest.strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });

    const loaded = await loadPlanById(deps.db, req.params.id, body.data.revision);
    if (loaded.kind === "not_found") {
      const person = await requirePerson(deps.iam, token);
      if (!person.ok) return refuse(reply, person, "plan_not_found");
      return reply.code(404).send({ error: "plan_not_found" });
    }
    if (loaded.kind === "corrupt") {
      const gate = await authorize(deps.iam, token, "POST /api/plans/:id/apply", {
        orgId: loaded.orgId,
      });
      if (!gate.ok) return refuse(reply, gate, "plan_not_found");
      req.log.error({ planId: req.params.id }, loaded.detail);
      return reply.code(500).send({ error: "stored_plan_invalid" });
    }

    const { plan } = loaded;
    const gate = await authorize(deps.iam, token, "POST /api/plans/:id/apply", {
      orgId: plan.manifest.orgId,
    });
    if (!gate.ok) return refuse(reply, gate, "plan_not_found");

    if (plan.planHash !== body.data.planHash) {
      return reply.code(409).send({
        error: "hash_mismatch",
        detail: "request hash does not match the stored revision",
      });
    }

    const at = deps.now?.() ?? new Date();
    const [existing] = await deps.db
      .select({ id: runs.id, state: runs.state })
      .from(runs)
      .where(
        and(
          eq(runs.orgId, plan.manifest.orgId),
          eq(runs.planHash, plan.planHash),
          inArray(runs.state, REUSABLE_STATES),
        ),
      )
      .orderBy(desc(runs.createdAt))
      .limit(1);
    if (existing) {
      return reply.code(202).send({ runId: existing.id, state: existing.state, existing: true });
    }

    const policies = deps.policies ?? [];
    const facts = approvalFacts(plan.manifest, policies);
    const grants = await deps.db
      .select()
      .from(approvalGrants)
      .where(
        and(
          eq(approvalGrants.orgId, plan.manifest.orgId),
          eq(approvalGrants.planHash, plan.planHash),
        ),
      );
    const admitted = await authorizeGrants(deps.iam, {
      orgId: plan.manifest.orgId,
      planHash: plan.planHash,
      revision: plan.revision,
      dualRequired: facts.dualRequired,
      requiredPermissions: facts.requiredPermissions,
      grants: grants.map((row) => grantFact(toApprovalGrant(row))),
    });
    if (!admitted.ok) return reply.code(admitted.status).send({ error: admitted.error });

    const { policies: loadedPolicies } = deps;
    const result = await requestApply(deps.db, deps.boss, {
      ...(loadedPolicies && {
        checkApprovals: (stored, storedGrants) => {
          const manifest = PlanManifest.safeParse(stored);
          if (!manifest.success) return null;
          const status = approvalStatus(
            manifest.data,
            body.data.planHash,
            loadedPolicies,
            storedGrants,
            at,
          );
          return status.satisfied ? null : explainShortfall(status);
        },
      }),
      orgId: plan.manifest.orgId,
      userId: gate.person.userId,
      planId: plan.planId,
      revision: plan.revision,
      planHash: plan.planHash,
      now: at,
    });

    switch (result.kind) {
      case "accepted":
        return reply
          .code(202)
          .send({ runId: result.runId, state: result.state, existing: result.existing });
      case "not_found":
        return reply.code(404).send({ error: "plan_not_found" });
      case "hash_mismatch":
        return reply.code(409).send({ error: "hash_mismatch", detail: result.detail });
      case "approval_invalid":
        return reply.code(403).send({ error: "approval_invalid", detail: result.detail });
    }
  });
}
