import { type PlanManifest, RepairRequest, StoredIncident } from "@rehearsal/contracts";
import {
  checkRepair,
  operationKey,
  orgTenant,
  type RepairRefresh,
  type RepairScope,
  repairScope,
} from "@rehearsal/core";
import { type Db, loadIncident, OrgWorldBusy, PgJournal, PLAN_QUEUE, schema } from "@rehearsal/db";
import {
  eraAdmin,
  eraFetch,
  mintTenantToken,
  type PlanJob,
  type PlanJobRepair,
  resolveWorld,
} from "@rehearsal/providers";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { authorize, bearerToken, refuse, requirePerson } from "./iam";
import { loadPlan, loadPlanById } from "./plans";
import { INCIDENTS, type RehearseDeps, registryForJob } from "./rehearse";

const { runs, stepAttempts } = schema;

/** Copies the given operational records into the org's planning world; returns the IDs it copied. */
export type RepairRefresher = (orgId: string, records: RepairRefresh[]) => Promise<string[]>;

/** A run still going can settle more steps; a repair waits for it. */
const ACTIVE_RUN_STATES = ["approved", "applying"];

/**
 * What a repair of this stored revision would keep and replan, from the journal: every receipt for
 * its hash, and any send of its steps still in flight under any revision (same operation key).
 */
export async function loadRepairScope(
  db: Db,
  manifest: PlanManifest,
  planHash: string,
): Promise<RepairScope> {
  const receipts = await new PgJournal(db, manifest.orgId).receiptsFor(planHash);
  const keys = new Map(
    manifest.actions.map((a) => [operationKey(manifest.orgId, manifest.planId, a), a.id]),
  );
  const inFlight = await db
    .select({ operationKey: stepAttempts.operationKey })
    .from(stepAttempts)
    .where(
      and(
        eq(stepAttempts.orgId, manifest.orgId),
        inArray(stepAttempts.operationKey, [...keys.keys()]),
        inArray(stepAttempts.state, ["dispatched", "unknown_outcome"]),
      ),
    );
  const ids = inFlight.map((r) => keys.get(r.operationKey)).filter((id): id is string => !!id);
  return repairScope(manifest, receipts, ids);
}

/**
 * Why a planner's repair can't be stored, or null. Checked against the stored base, not the job's
 * copy of it: the base must still be the latest revision, the run's receipts must still give the
 * same scope, and the repair must keep every confirmed step byte-for-byte.
 */
export async function repairProblem(
  db: Db,
  repair: PlanJobRepair,
  next: PlanManifest,
): Promise<string | null> {
  const loaded = await loadPlan(db, next.orgId, next.planId, repair.base.revision);
  if (loaded.kind !== "found") return "the repaired revision is no longer stored";
  if (loaded.plan.planHash !== repair.basePlanHash) return "the repaired revision changed";
  if (loaded.latestRevision !== loaded.plan.revision) {
    return `revision ${loaded.latestRevision} already replaced the repaired revision`;
  }
  const scope = await loadRepairScope(db, loaded.plan.manifest, loaded.plan.planHash);
  if (!scope.ok) return `no longer repairable: ${scope.reason}`;
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
  if (!same(scope.kept, repair.kept) || !same(scope.openCases, repair.openCases)) {
    return "the run's receipts changed since the repair was requested";
  }
  const problems = checkRepair(loaded.plan.manifest, scope, next);
  return problems.length > 0 ? `repair is invalid: ${problems.join("; ")}` : null;
}

/** Why each replaced step stopped, from its latest receipt, for the planner's brief. */
async function stoppedSteps(db: Db, manifest: PlanManifest, planHash: string, ids: string[]) {
  const latest = new Map(
    (await new PgJournal(db, manifest.orgId).receiptsFor(planHash)).map((r) => [r.actionId, r]),
  );
  return ids.map((id) => {
    const r = latest.get(id);
    const hold = r?.holdReason;
    const why =
      hold?.kind === "query_membership_changed"
        ? `held: ${hold.added.join(", ")} newly matched its query`
        : hold
          ? `${r?.outcome}: ${hold.kind}`
          : (r?.outcome ?? "never ran");
    return { id, why: why.slice(0, 500) };
  });
}

/**
 * `POST /api/plans/:id/repair` (T1.37, decision 0016). Names a finished run of the latest revision
 * by ID and hash; the browser never sends steps. Refreshes the planning copy with the records the
 * run's holds found, then queues a plan job for the open cases. The stored repair is the next
 * revision, and like any revision it needs its own approval before it can be applied.
 */
export function registerRepairRoute(app: FastifyInstance, deps: RehearseDeps) {
  app.post<{ Params: { id: string } }>("/api/plans/:id/repair", async (req, reply) => {
    const token = bearerToken(req);
    if (!token) return reply.code(401).send({ error: "unauthenticated" });
    const body = RepairRequest.strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });

    const loaded = await loadPlanById(deps.db, req.params.id, body.data.revision);
    if (loaded.kind === "not_found") {
      const person = await requirePerson(deps.iam, token);
      if (!person.ok) return refuse(reply, person, "plan_not_found");
      return reply.code(404).send({ error: "plan_not_found" });
    }
    const orgId = loaded.kind === "corrupt" ? loaded.orgId : loaded.plan.manifest.orgId;
    const gate = await authorize(deps.iam, token, "POST /api/plans/:id/repair", { orgId });
    if (!gate.ok) return refuse(reply, gate, "plan_not_found");
    if (loaded.kind === "corrupt") {
      req.log.error({ planId: req.params.id }, loaded.detail);
      return reply.code(500).send({ error: "stored_plan_invalid" });
    }
    const { plan } = loaded;
    if (plan.planHash !== body.data.planHash)
      return reply.code(409).send({ error: "hash_mismatch" });
    if (loaded.latestRevision !== plan.revision) {
      return reply
        .code(409)
        .send({ error: "stale_revision", latestRevision: loaded.latestRevision });
    }

    const [run] = await deps.db
      .select({ state: runs.state })
      .from(runs)
      .where(
        and(
          eq(runs.id, body.data.runId),
          eq(runs.orgId, orgId),
          eq(runs.planId, plan.planId),
          eq(runs.planHash, plan.planHash),
        ),
      );
    if (!run) return reply.code(404).send({ error: "run_not_found" });
    const [active] = await deps.db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.orgId, orgId),
          eq(runs.planId, plan.planId),
          inArray(runs.state, ACTIVE_RUN_STATES),
        ),
      )
      .limit(1);
    if (active) return reply.code(409).send({ error: "work_in_progress", runId: active.id });

    const scope = await loadRepairScope(deps.db, plan.manifest, plan.planHash);
    if (!scope.ok) return reply.code(409).send({ error: "not_repairable", detail: scope.reason });

    let refreshed: string[] = [];
    if (scope.refresh.length > 0) {
      if (!deps.refreshPlanning) {
        return reply.code(409).send({
          error: "not_repairable",
          detail: "this deployment can't refresh the planning world",
        });
      }
      try {
        refreshed = await deps.refreshPlanning(orgId, scope.refresh);
      } catch (error) {
        if (error instanceof OrgWorldBusy) {
          return reply.code(409).send({ error: "work_in_progress" });
        }
        req.log.error({ err: error }, "planning world could not be refreshed");
        return reply.code(502).send({ error: "world_unavailable" });
      }
    }

    const { manifest } = plan;
    const filed = StoredIncident.shape.incidentId.safeParse(manifest.incidentId).success
      ? await loadIncident(deps.db, orgId, manifest.incidentId)
      : undefined;
    if (!filed && !INCIDENTS.has(manifest.incidentId)) {
      return reply.code(404).send({ error: "incident_not_found" });
    }
    const job: PlanJob = {
      orgId,
      incidentId: manifest.incidentId,
      planId: plan.planId,
      requestedBy: gate.person.userId,
      ...(deps.precedentRegistry && {
        precedents: registryForJob(await deps.precedentRegistry(orgId)),
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
      repair: {
        base: manifest,
        basePlanHash: plan.planHash,
        runId: body.data.runId,
        kept: scope.kept,
        openCases: scope.openCases,
        stopped: await stoppedSteps(deps.db, manifest, plan.planHash, scope.replanned),
      },
    };
    let jobId: string | null;
    try {
      jobId = deps.enqueue ? await deps.enqueue(job) : await deps.boss.send(PLAN_QUEUE, job);
    } catch (error) {
      if (error instanceof OrgWorldBusy) return reply.code(409).send({ error: "work_in_progress" });
      req.log.error({ err: error }, "repair job could not be queued");
      return reply.code(502).send({ error: "world_unavailable" });
    }
    if (!jobId) return reply.code(503).send({ error: "not_enqueued" });
    return reply.code(202).send({
      rehearsalId: jobId,
      planId: plan.planId,
      baseRevision: plan.revision,
      revision: plan.revision + 1,
      state: "queued",
      kept: scope.kept,
      openCases: scope.openCases,
      replanned: scope.replanned,
      refreshed,
    });
  });
}

const VENDOR_AUTH = {
  stripe: "Bearer sk_test_rehearsal_repair",
  zendesk: "Bearer rehearsal-repair",
} as const;

/**
 * The refresher over the Era worlds this API's environment names. For each record a hold found,
 * it reads the operational copy and injects it into the planning world unless that world already
 * has it (Era's inject doesn't dedupe). Only the org's own tenant (`orgTenant`), and only records
 * the executor itself reported: the request names none.
 */
export function eraPlanningRefresher(
  env: NodeJS.ProcessEnv = process.env,
): RepairRefresher | undefined {
  const adminToken = env.ERA_ADMIN_TOKEN;
  if (!adminToken) return undefined;
  return async (orgId, records) => {
    const tenant = orgTenant(orgId);
    const copied: string[] = [];
    for (const record of records) {
      if (record.vendor === "slack") throw new Error("slack records are never refreshed");
      const vendor = record.vendor;
      const path =
        vendor === "stripe"
          ? `/v1/charges/${encodeURIComponent(record.id)}`
          : `/api/v2/tickets/${encodeURIComponent(record.id)}.json`;
      const get = async (world: "planning" | "operational") => {
        const config = resolveWorld(vendor, world, env, tenant);
        const { token } = await mintTenantToken(config, adminToken);
        const res = await eraFetch({ ...config, tenantToken: token }, path, {
          headers: { authorization: VENDOR_AUTH[vendor] },
        });
        return { config, res };
      };
      const planning = await get("planning");
      if (planning.res.ok) continue;
      if (planning.res.status !== 404) {
        throw new Error(`planning GET ${path} → ${planning.res.status}`);
      }
      const operational = await get("operational");
      if (!operational.res.ok)
        throw new Error(`operational GET ${path} → ${operational.res.status}`);
      const found = (await operational.res.json()) as Record<string, unknown>;
      const body =
        vendor === "stripe" ? { charges: [found] } : { tickets: [found.ticket ?? found] };
      const res = await eraAdmin(planning.config, adminToken, "/inject", body);
      if (!res.ok) throw new Error(`${vendor} planning inject → ${res.status}`);
      copied.push(record.id);
    }
    return copied;
  };
}
