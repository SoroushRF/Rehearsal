import { IncidentDraft } from "@rehearsal/contracts";
import { type Db, insertIncident, listIncidents } from "@rehearsal/db";
import type { FastifyInstance } from "fastify";
import { authorizeCollection, bearerToken, type IamClient, refuse } from "./iam";

/**
 * Live demo (#331): incidents an org files itself, then rehearses through
 * `POST /api/incidents/:id/rehearse`. Rows are the org's own and append-only; the org is the one
 * IAM verified, never a value from the body.
 */
export interface IncidentDeps {
  db: Db;
  iam?: IamClient;
}

export function registerIncidentRoutes(app: FastifyInstance, deps: IncidentDeps) {
  app.post("/api/incidents", async (req, reply) => {
    const gate = await authorizeCollection(deps.iam, bearerToken(req), "POST /api/incidents");
    if (!gate.ok) return refuse(reply, gate, "not_found");
    const body = IncidentDraft.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const { createdGte, createdLt } = body.data.window;
    if (Date.parse(createdGte) >= Date.parse(createdLt)) {
      return reply.code(400).send({ error: "invalid_window" });
    }
    const stored = await insertIncident(deps.db, gate.person.orgId, gate.person.userId, body.data);
    return reply.code(201).send(stored);
  });

  app.get("/api/incidents", async (req, reply) => {
    const gate = await authorizeCollection(deps.iam, bearerToken(req), "GET /api/incidents");
    if (!gate.ok) return refuse(reply, gate, "not_found");
    return listIncidents(deps.db, gate.person.orgId);
  });
}
