import { requestCancel, schema } from "@rehearsal/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ApplyDeps } from "./apply";
import { authorize, bearerToken, refuse, requirePerson } from "./iam";

/**
 * `POST /api/runs/:id/cancel` stops a waiting or applying run before its next step or send.
 * Effects that already happened stay (and keep their receipts); nothing is rolled back.
 */
export function registerCancelRoute(app: FastifyInstance, deps: Pick<ApplyDeps, "db" | "iam">) {
  app.post<{ Params: { id: string } }>("/api/runs/:id/cancel", async (req, reply) => {
    const token = bearerToken(req);
    if (!token) return reply.code(401).send({ error: "unauthenticated" });
    const [run] = await deps.db.select().from(schema.runs).where(eq(schema.runs.id, req.params.id));
    if (!run) {
      const person = await requirePerson(deps.iam, token);
      if (!person.ok) return refuse(reply, person, "run_not_found");
      return reply.code(404).send({ error: "run_not_found" });
    }
    const gate = await authorize(deps.iam, token, "POST /api/runs/:id/cancel", {
      orgId: run.orgId,
    });
    if (!gate.ok) return refuse(reply, gate, "run_not_found");
    const result = await requestCancel(deps.db, { orgId: run.orgId, runId: req.params.id });
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
