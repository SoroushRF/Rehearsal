import { type Db, schema } from "@rehearsal/db";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authorize, bearerToken, type IamClient, refuse, requirePerson } from "./iam";

const { runs, runEvents } = schema;

export interface RunDeps {
  db: Db;
  iam?: IamClient;
}

/** Page size for event polling. A run writes a handful of events per step. */
export const EVENT_PAGE = 500;

const EventsQuery = z.object({ after: z.coerce.number().int().nonnegative().default(0) });

function runView(r: typeof runs.$inferSelect) {
  return {
    id: r.id,
    planId: r.planId,
    revision: r.revision,
    planHash: r.planHash,
    approvalId: r.approvalId,
    requestedBy: r.requestedBy,
    state: r.state,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/**
 * Read-only views of what the executor did. The UI polls `events?after=<last seq>`; one executor
 * writes each run, so a run's events arrive in `seq` order.
 */
export function registerRunRoutes(app: FastifyInstance, deps: RunDeps) {
  app.get<{ Params: { id: string } }>("/api/runs/:id/events", async (req, reply) => {
    const token = bearerToken(req);
    if (!token) return reply.code(401).send({ error: "unauthenticated" });
    const query = EventsQuery.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_request" });

    const [run] = await deps.db.select().from(runs).where(eq(runs.id, req.params.id));
    if (!run) {
      const person = await requirePerson(deps.iam, token);
      if (!person.ok) return refuse(reply, person, "run_not_found");
      return reply.code(404).send({ error: "run_not_found" });
    }
    const gate = await authorize(deps.iam, token, "GET /api/runs/:id/events", { orgId: run.orgId });
    if (!gate.ok) return refuse(reply, gate, "run_not_found");

    const rows = await deps.db
      .select()
      .from(runEvents)
      .where(
        and(
          eq(runEvents.orgId, run.orgId),
          eq(runEvents.runId, run.id),
          gt(runEvents.seq, query.data.after),
        ),
      )
      .orderBy(asc(runEvents.seq))
      .limit(EVENT_PAGE);
    return {
      run: runView(run),
      events: rows.map((e) => ({
        seq: e.seq,
        runId: e.runId,
        type: e.type,
        at: e.at.toISOString(),
        payload: e.payload,
      })),
      /** More events are waiting beyond this page. */
      more: rows.length === EVENT_PAGE,
    };
  });

  /**
   * A plan's runs. There is no plan document to load: the org is the one on the stored run rows.
   * No runs is an empty list. Runs that all belong to another org are missing.
   */
  app.get<{ Params: { id: string } }>("/api/plans/:id/runs", async (req, reply) => {
    const token = bearerToken(req);
    if (!token) return reply.code(401).send({ error: "unauthenticated" });
    const person = await requirePerson(deps.iam, token);
    if (!person.ok) return refuse(reply, person, "plan_not_found");

    const rows = await deps.db
      .select()
      .from(runs)
      .where(eq(runs.planId, req.params.id))
      .orderBy(desc(runs.createdAt));
    if (rows.length === 0) return { runs: [] };

    const mine = rows.filter((row) => row.orgId === person.person.orgId);
    const orgId = mine[0]?.orgId;
    if (!orgId) return reply.code(404).send({ error: "plan_not_found" });
    const gate = await authorize(deps.iam, token, "GET /api/plans/:id/runs", { orgId });
    if (!gate.ok) return refuse(reply, gate, "plan_not_found");
    return { runs: mine.map(runView) };
  });
}
