import { randomUUID } from "node:crypto";
import { PlanManifest, StoredIncident } from "@rehearsal/contracts";
import { planHash, validateGraph } from "@rehearsal/core";
import {
  type Db,
  loadIncident,
  OrgWorldBusy,
  type PgBoss,
  PLAN_QUEUE,
  type RegistrySnapshot,
} from "@rehearsal/db";
import { checkPrecedentBasis } from "@rehearsal/memory";
import {
  PLANNER_JOB_ROUTES,
  PlanJob,
  type PlanJobRegistry,
  PlanModelAttempts,
  registryOfJob,
} from "@rehearsal/providers";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import incident from "../../../scenarios/billing/incident.v1.json" with { type: "json" };
import {
  authorize,
  authorizeCollection,
  bearerToken,
  type IamClient,
  refuse,
  requirePerson,
} from "./iam";
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
  iam?: IamClient;
  /** PLANNER_WORKER_SECRET. Without it the internal planner routes refuse everyone. */
  plannerSecret?: string;
  /**
   * The org's precedent registry (#235). A plan job carries it so the planner cites only active
   * versions, and the returned basis is checked against it. Absent: plans carry no basis.
   */
  precedentRegistry?: (orgId: string) => Promise<RegistrySnapshot>;
  /**
   * Seeds a new org's own Era tenants before its first plan (#330), so the planner never reads an
   * empty world. Absent: nothing is seeded (the shared tenant, tests).
   */
  ensureSeeded?: (orgId: string) => Promise<void>;
  /** Production seeding and enqueue share the reset lock and commit the job before releasing it. */
  enqueue?: (job: PlanJob) => Promise<string | null>;
}

/** Incidents this deployment can rehearse. The planner worker loads the brief by ID. */
export const INCIDENTS: ReadonlySet<string> = new Set([incident.incident]);

const JobId = z.uuid();
const FiledIncidentId = StoredIncident.shape.incidentId;
const Complete = z.strictObject({
  manifest: z.unknown(),
  summary: z.string().max(4000),
  stats: z
    .object({
      turns: z.int().nonnegative(),
      toolCalls: z.int().nonnegative(),
      usage: z.record(z.string(), z.int().nonnegative()),
      modelAttempts: PlanModelAttempts.optional(),
    })
    .optional(),
});
const Fail = z.strictObject({
  reason: z.string().max(100),
  message: z.string().max(2000),
  modelAttempts: PlanModelAttempts.optional(),
});

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
    // The incident catalog is not stored per organization. The job is created in the org IAM
    // verified, and the permission check is what stops a member from spending model tokens.
    const gate = await authorizeCollection(
      deps.iam,
      bearerToken(req),
      "POST /api/incidents/:id/rehearse",
    );
    if (!gate.ok) return refuse(reply, gate, "incident_not_found");
    // A built-in incident the worker knows by ID, or one this org filed (#331), sent with the job.
    const builtIn = INCIDENTS.has(req.params.id);
    const filed = !FiledIncidentId.safeParse(req.params.id).success
      ? undefined
      : await loadIncident(deps.db, gate.person.orgId, req.params.id);
    if (!builtIn && !filed) return reply.code(404).send({ error: "incident_not_found" });
    try {
      await deps.ensureSeeded?.(gate.person.orgId);
    } catch (error) {
      req.log.error({ err: error }, "org worlds could not be seeded");
      return reply.code(502).send({ error: "world_unavailable" });
    }

    const job: PlanJob = {
      orgId: gate.person.orgId,
      incidentId: req.params.id,
      planId: `plan_${randomUUID()}`,
      requestedBy: gate.person.userId,
      ...(deps.precedentRegistry && {
        precedents: registryForJob(await deps.precedentRegistry(gate.person.orgId)),
      }),
      ...(filed && {
        incident: {
          incidentId: filed.incidentId,
          kind: filed.kind,
          title: filed.title,
          description: filed.description,
          window: filed.window,
        },
      }),
    };
    let jobId: string | null;
    try {
      jobId = deps.enqueue
        ? await deps.enqueue(PlanJob.parse(job))
        : await deps.boss.send(PLAN_QUEUE, PlanJob.parse(job));
    } catch (error) {
      if (error instanceof OrgWorldBusy) return reply.code(409).send({ error: "work_in_progress" });
      req.log.error({ err: error }, "plan job could not be queued");
      return reply.code(502).send({ error: "world_unavailable" });
    }
    if (!jobId) return reply.code(503).send({ error: "not_enqueued" });
    return reply.code(202).send({ rehearsalId: jobId, planId: job.planId, state: "queued" });
  });

  app.get<{ Params: { id: string } }>("/api/rehearsals/:id", async (req, reply) => {
    const token = bearerToken(req);
    if (!token) return reply.code(401).send({ error: "unauthenticated" });
    const found = await loadJob(deps, req.params.id);
    if (!found) {
      const person = await requirePerson(deps.iam, token);
      if (!person.ok) return refuse(reply, person, "rehearsal_not_found");
      return reply.code(404).send({ error: "rehearsal_not_found" });
    }
    const gate = await authorize(deps.iam, token, "GET /api/rehearsals/:id", {
      orgId: found.data.orgId,
    });
    if (!gate.ok) return refuse(reply, gate, "rehearsal_not_found");
    const output = (found.job.output ?? {}) as Record<string, unknown>;
    const attempts = PlanModelAttempts.safeParse(output.modelAttempts);
    const state = STATE[found.job.state];
    return {
      rehearsalId: found.job.id,
      planId: found.data.planId,
      incidentId: found.data.incidentId,
      state,
      ...(attempts.success ? { modelAttempts: attempts.data } : {}),
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
    // An out-of-scope incident plans nothing; the model's reason is what the reviewer needs to see.
    if (m.actions.length === 0) {
      return refuse(`plan has no steps: ${body.data.summary}`.slice(0, 2000));
    }
    const problems = validateGraph(m.actions);
    if (problems.length > 0) return refuse(`plan graph is invalid: ${JSON.stringify(problems)}`);
    const precedentProblem = checkJobBasis(m, job);
    if (precedentProblem) return refuse(precedentProblem);

    let stored = await storePlan(deps.db, m);
    if (!stored) {
      // A repeat of a completion that stored but didn't finish the job is fine; anything else isn't.
      // Compare canonical hashes: JSONB doesn't keep key order, so the stored copy reads back
      // reordered. loadPlan has already checked the stored row against its own hash.
      const existing = await loadPlan(deps.db, m.orgId, m.planId, 1);
      if (existing.kind !== "found" || existing.plan.planHash !== planHash(m)) {
        return refuse("plan ID already holds another plan");
      }
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

function registryForJob(snapshot: RegistrySnapshot): PlanJobRegistry {
  return {
    active: [...snapshot.active].map(([id, v]) => ({ id, version: v.version, digest: v.digest })),
    epochs: Object.fromEntries(snapshot.epochs),
  };
}

/**
 * A plan's precedent basis must be what the job allowed: cited versions active in the job's
 * registry, and every one of its areas consulted at the job's epoch. A worker can't cite a
 * withdrawn precedent or skip an area, and a job without precedents gets a plan without a basis.
 */
export function checkJobBasis(m: PlanManifest, job: PlanJob): string | null {
  const areas = Object.keys(job.precedents?.epochs ?? {});
  if (!m.precedentBasis) {
    return areas.length > 0 ? "plan has no precedent basis but the org has precedents" : null;
  }
  if (!job.precedents || areas.length === 0) return "plan cites precedents the job didn't offer";
  const cited = Object.keys(m.precedentBasis.epochs).sort();
  if (cited.join("\n") !== areas.sort().join("\n")) {
    return "plan's precedent areas differ from the org's registry";
  }
  const check = checkPrecedentBasis(m.precedentBasis, registryOfJob(job.precedents));
  return check.ok ? null : `plan's precedent basis doesn't hold: ${JSON.stringify(check.holds)}`;
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
