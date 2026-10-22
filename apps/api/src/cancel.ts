import { requestCancel } from "@rehearsal/db";
import type { FastifyInstance } from "fastify";
import type { ApplyDeps } from "./apply";

/**
 * `POST /api/runs/:id/cancel` stops a waiting or applying run before its next step or send.
 * Effects that already happened stay (and keep their receipts); nothing is rolled back.
 */
export function registerCancelRoute(app: FastifyInstance, deps: Pick<ApplyDeps, "db" | "auth">) {
  app.post<{ Params: { id: string } }>("/api/runs/:id/cancel", async (req, reply) => {
    const auth = await deps.auth(req);
    if (!auth) return reply.code(401).send({ error: "unauthenticated" });
    const result = await requestCancel(deps.db, { orgId: auth.orgId, runId: req.params.id });
    switch (result.kind) {
      case "cancelled":
        return reply.code(202).send({ runId: result.runId, state: "cancelled" });
      case "not_found":
        return reply.code(404).send({ error: "run_not_found" });
      case "not_active":
        return reply.code(409).send({ error: "run_not_active", state: result.state });
    }
  });
}
