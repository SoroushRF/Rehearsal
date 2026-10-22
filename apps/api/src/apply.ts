import { ApplyRequest } from "@rehearsal/contracts";
import { type Db, type PgBoss, requestApply } from "@rehearsal/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

/** Who is calling, as verified server-side. Clerk (T2.3) provides the real resolver. */
export interface AuthContext {
  orgId: string;
  userId: string;
}
export type AuthResolver = (
  req: FastifyRequest,
) => AuthContext | null | Promise<AuthContext | null>;

/** Until Clerk is wired in, every command is unauthenticated and refused. */
export const noAuth: AuthResolver = () => null;

export interface ApplyDeps {
  db: Db;
  boss: PgBoss;
  auth: AuthResolver;
  now?: () => Date;
}

/**
 * `POST /api/plans/:id/apply` names a stored revision and its hash; the browser never sends action
 * bodies. It enqueues work and returns a run ID. The executor does the actual admission checks.
 */
export function registerApplyRoute(app: FastifyInstance, deps: ApplyDeps) {
  app.post<{ Params: { id: string } }>("/api/plans/:id/apply", async (req, reply) => {
    const auth = await deps.auth(req);
    if (!auth) return reply.code(401).send({ error: "unauthenticated" });

    // Strict: a body carrying anything besides the revision and hash (e.g. actions) is refused.
    const body = ApplyRequest.strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });

    const result = await requestApply(deps.db, deps.boss, {
      orgId: auth.orgId,
      userId: auth.userId,
      planId: req.params.id,
      revision: body.data.revision,
      planHash: body.data.planHash,
      now: deps.now?.() ?? new Date(),
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
