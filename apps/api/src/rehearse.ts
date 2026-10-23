import { randomUUID } from "node:crypto";
import { PlanManifest } from "@rehearsal/contracts";
import { validateGraph } from "@rehearsal/core";
import { type Db, type PgBoss, PLAN_QUEUE } from "@rehearsal/db";
import { PLANNER_JOB_ROUTES, PlanJob } from "@rehearsal/providers";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import incident from "../../../scenarios/billing/incident.v1.json" with { type: "json" };
import type { ReviewerResolver } from "./auth";
import { loadPlan, storePlan } from "./plans";
import { workerRole } from "./tenant-tokens";

/**
 * T1.5: rehearsing an incident. A reviewer asks for a plan; the API queues a `plan` job and returns
 * the plan ID it will have. The planner worker holds the model key but no database access, so it
 * takes jobs and hands back manifests through the internal routes here, authenticated with its own
 * secret (docs/decisions/0006-planner-jobs-through-api.md). The API checks a returned manifest
 * against the job before storing it as revision 1.
 */
export interface RehearseDeps {
  db: Db;
  boss: PgBoss;
  reviewer: ReviewerResolver;
  /** PLANNER_WORKER_SECRET. Without it the internal planner routes refuse everyone. */
  plannerSecret?: string;
}

/** Incidents this deployment can rehearse. The planner worker loads the brief by ID. */
export const INCIDENTS: ReadonlySet<string> = new Set([incident.incident]);

const JobId = z.uuid();
const Complete = z.strictObject({
  manifest: z.unknown(),
  summary: z.string().max(4000),
  stats: z
    .object({
      turns: z.int().nonnegative(),
      toolCalls: z.int().nonnegative(),
      usage: z.record(z.string(), z.int().nonnegative()),
    })
    .optional(),
});
const Fail = z.strictObject({ reason: z.string().max(100), message: z.string().max(2000) });

/** pg-boss states, as the review page should read them. A failed run is retried once. */
const STATE = {
  created: "queued",
  retry: "retrying",
  active: "planning",
  completed: "stored",
  failed: "failed",
  cancelled: "failed",
} as const;

export function registerRehearseRoutes(app: FastifyInstance, deps: RehearseDeps) {
  app.post<{ Params: { id: string } }>("/api/incidents/:id/rehearse", async (req, reply) => {
    const reviewer = await deps.reviewer(req);
    if (!reviewer) return reply.code(401).send({ error: "unauthenticated" });
    // Rehearsing spends model tokens; only someone who could approve a plan may ask for one.
    if (reviewer.roles.length === 0) return reply.code(403).send({ error: "forbidden" });
    if (!INCIDENTS.has(req.params.id)) return reply.code(404).send({ error: "incident_not_found" });

    const job: PlanJob = {
      orgId: reviewer.orgId,
      incidentId: req.params.id,
      planId: `plan_${randomUUID()}`,
      requestedBy: reviewer.userId,
    };
    const jobId = await deps.boss.send(PLAN_QUEUE, PlanJob.parse(job));
    if (!jobId) return reply.code(503).send({ error: "not_enqueued" });
    return reply.code(202).send({ rehearsalId: jobId, planId: job.planId, state: "queued" });
  });

  app.get<{ Params: { id: string } }>("/api/rehearsals/:id", async (req, reply) => {
    const reviewer = await deps.reviewer(req);
    if (!reviewer) return reply.code(401).send({ error: "unauthenticated" });
    const found = await loadJob(deps, req.params.id);
    // Another org's rehearsal is indistinguishable from a missing one.
    if (!found || found.data.orgId !== reviewer.orgId) {
      return reply.code(404).send({ error: "rehearsal_not_found" });
    }
    const output = (found.job.output ?? {}) as Record<string, unknown>;
    const state = STATE[found.job.state];
    return {
      rehearsalId: found.job.id,
      planId: found.data.planId,
      incidentId: found.data.incidentId,
      state,
      // The last failure, which a retry may still turn into a stored plan.
      ...((state === "failed" || state === "retrying") && {
        error: { reason: output.reason, message: output.message },
      }),
      ...(state === "stored" && { planHash: output.planHash, summary: output.summary }),
    };
  });

  const planner = (authorization: string | undefined) =>
    deps.plannerSecret !== undefined &&
    workerRole(authorization, { planner: deps.plannerSecret }) === "planner";

  app.post(PLANNER_JOB_ROUTES.next, async (req, reply) => {
    if (!planner(req.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
    const [job] = await deps.boss.fetch<PlanJob>(PLAN_QUEUE, { batchSize: 1 });
    if (!job) return reply.code(204).send();
    const data = PlanJob.safeParse(job.data);
    if (!data.success) {
      await deps.boss.fail(PLAN_QUEUE, job.id, { reason: "malformed_job", message: "bad payload" });
      return reply.code(204).send();
    }
    return { id: job.id, data: data.data };
  });

  app.post<{ Params: { id: string } }>(PLANNER_JOB_ROUTES.complete, async (req, reply) => {
    if (!planner(req.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
    const body = Complete.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const found = await activeJob(deps, req.params.id, reply);
    if (!found) return reply;

    const refuse = async (detail: string) => {
      await deps.boss.fail(PLAN_QUEUE, found.job.id, { reason: "rejected_plan", message: detail });
      return reply.code(422).send({ error: "rejected_plan", detail });
    };
    const parsed = PlanManifest.safeParse(body.data.manifest);
    if (!parsed.success) return refuse("manifest does not match contracts v1");
    const m = parsed.data;
    const job = found.data;
    if (m.orgId !== job.orgId || m.planId !== job.planId || m.incidentId !== job.incidentId) {
      return refuse("manifest is for another org, plan or incident than the job");
    }
    if (m.revision !== 1 || m.parentRevision !== null || m.excluded.length > 0) {
      return refuse("a planner run produces revision 1 only");
    }
    if (m.actions.length === 0) return refuse("plan has no steps");
    const problems = validateGraph(m.actions);
    if (problems.length > 0) return refuse(`plan graph is invalid: ${JSON.stringify(problems)}`);

    let stored = await storePlan(deps.db, m);
    if (!stored) {
      // A repeat of a completion that stored but didn't finish the job is fine; anything else isn't.
      const existing = await loadPlan(deps.db, m.orgId, m.planId, 1);
      const same =
        existing.kind === "found" && JSON.stringify(existing.plan.manifest) === JSON.stringify(m);
      if (!same || existing.kind !== "found") return refuse("plan ID already holds another plan");
      stored = { planHash: existing.plan.planHash };
    }
    await deps.boss.complete(PLAN_QUEUE, found.job.id, {
      planHash: stored.planHash,
      summary: body.data.summary,
      ...body.data.stats,
    });
    return reply.code(201).send({ planId: m.planId, revision: 1, planHash: stored.planHash });
  });

  app.post<{ Params: { id: string } }>(PLANNER_JOB_ROUTES.fail, async (req, reply) => {
    if (!planner(req.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
    const body = Fail.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const found = await activeJob(deps, req.params.id, reply);
    if (!found) return reply;
    await deps.boss.fail(PLAN_QUEUE, found.job.id, body.data);
    return reply.code(204).send();
  });
}

async function loadJob(deps: RehearseDeps, id: string) {
  if (!JobId.safeParse(id).success) return undefined;
  const job = await deps.boss.getJobById<PlanJob>(PLAN_QUEUE, id);
  const data = PlanJob.safeParse(job?.data);
  return job && data.success ? { job, data: data.data } : undefined;
}

/** Only a job the worker is holding can be completed or failed; an expired one has moved on. */
async function activeJob(deps: RehearseDeps, id: string, reply: FastifyReply) {
  const found = await loadJob(deps, id);
  if (!found) {
    reply.code(404).send({ error: "job_not_found" });
    return undefined;
  }
  if (found.job.state !== "active") {
    reply.code(409).send({ error: "job_not_active", state: found.job.state });
    return undefined;
  }
  return found;
}
