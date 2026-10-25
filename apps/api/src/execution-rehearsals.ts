import { randomBytes } from "node:crypto";
import {
  ExecutionRehearsalReportView,
  ExecutionRehearsalRequest,
  type ExecutionRehearsalState,
  type PlanManifest,
  type RehearsalScenarioRef,
  type RehearsalVersions,
  TERMINAL_REHEARSAL_STATES,
} from "@rehearsal/contracts";
import {
  CHALLENGE_CATALOG,
  CHALLENGE_CATALOG_VERSION,
  fingerprint,
  REHEARSAL_REPORT_TTL_MS,
  rehearsalStaleness,
} from "@rehearsal/core";
import {
  cancelRehearsal,
  type Db,
  listRehearsalsForPlan,
  loadRehearsal,
  loadRehearsalReport,
  type PgBoss,
  rehearsalOrgOf,
  requestRehearsal,
  type StoredRehearsal,
} from "@rehearsal/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { supportSnapshot } from "../../../scripts/seed/snapshot";
import { authorize, bearerToken, type IamClient, refuse, requirePerson } from "./iam";
import { loadPlan, loadPlanById } from "./plans";

/**
 * T2.19 (decision 0013): request and read an execution rehearsal. The browser names a stored plan,
 * its revision and hash, and a scenario from an allowlist. The server loads the manifest, binds the
 * snapshot and policy itself, and queues one `rehearsal` job. A rehearsal grants nothing: no route
 * here creates, reads or extends an approval, and a report is advice the review page shows.
 */
export interface ExecutionRehearsalDeps {
  db: Db;
  boss: PgBoss;
  iam?: IamClient;
  /**
   * The current build's execution versions, to tell a stale report from a current one. Without it
   * `versions_changed` is not asserted: the report's own provenance still lists what it ran on.
   */
  currentVersions?: () => Omit<RehearsalVersions, "commit">;
  /** Whether a plan's evidence can be rebuilt in a disposable world. The seeder's own check. */
  checkSnapshot?: SnapshotCheck;
  now?: () => Date;
  newId?: () => string;
}

export type SnapshotCheck = (
  manifest: PlanManifest,
) => { ok: true } | { ok: false; refusals: string[] };

/**
 * The scenarios the rehearsal worker can run, by ID and version: the published challenge catalog
 * (T4.11), which the runner applies (T3.16). Anything else is refused here rather than queued.
 */
export const SUPPORTED_SCENARIOS: readonly RehearsalScenarioRef[] = CHALLENGE_CATALOG.filter(
  (s) => s.version === CHALLENGE_CATALOG_VERSION && !s.containerWide,
).map((s) => ({ id: s.id, version: s.version }));

const supported = (s: RehearsalScenarioRef) =>
  SUPPORTED_SCENARIOS.some((x) => x.id === s.id && x.version === s.version);

/** A caller's own retry key. Optional; without one the server derives it from the request. */
const IdempotencyKey = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);

const ReportQuery = z.object({ revision: z.coerce.number().int().positive().optional() });

const isTerminal = (state: ExecutionRehearsalState) =>
  (TERMINAL_REHEARSAL_STATES as readonly string[]).includes(state);

/** One rehearsal as the list returns it. Detail says why it failed or was cancelled. */
export function summarize(s: StoredRehearsal) {
  const r = s.rehearsal;
  const last = s.events.at(-1);
  // The teardown event repeats the final state; the reason lives on the one before it.
  const lifecycle = [...s.events].reverse().find((e) => e.tornDownAt === null) ?? last;
  return {
    rehearsalId: r.id,
    plan: { orgId: r.orgId, planId: r.planId, revision: r.revision, planHash: r.planHash },
    scenario: { id: r.scenarioId, version: r.scenarioVersion },
    state: s.state,
    detail: lifecycle?.detail ?? null,
    requestedBy: r.requestedBy,
    requestedAt: r.requestedAt.toISOString(),
    updatedAt: (last?.at ?? r.requestedAt).toISOString(),
  };
}

/** The moment a rehearsal reached its terminal state, or null while it is still going. */
const finishedAt = (s: StoredRehearsal) =>
  isTerminal(s.state)
    ? (s.events.find((e) => e.state === s.state && e.tornDownAt === null)?.at ?? null)
    : null;

export function registerExecutionRehearsalRoutes(
  app: FastifyInstance,
  deps: ExecutionRehearsalDeps,
) {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => randomBytes(8).toString("hex"));
  const checkSnapshot: SnapshotCheck = deps.checkSnapshot ?? supportSnapshot;

  app.get<{ Params: { id: string } }>("/api/plans/:id/execution-rehearsals", async (req, reply) => {
    const token = bearerToken(req);
    if (!token) return reply.code(401).send({ error: "unauthenticated" });
    const loaded = await loadPlanById(deps.db, req.params.id);
    if (loaded.kind === "not_found") {
      const person = await requirePerson(deps.iam, token);
      if (!person.ok) return refuse(reply, person, "plan_not_found");
      return reply.code(404).send({ error: "plan_not_found" });
    }
    const orgId = loaded.kind === "corrupt" ? loaded.orgId : loaded.plan.manifest.orgId;
    const gate = await authorize(deps.iam, token, "GET /api/plans/:id/execution-rehearsals", {
      orgId,
    });
    if (!gate.ok) return refuse(reply, gate, "plan_not_found");
    const rows = await listRehearsalsForPlan(deps.db, orgId, req.params.id);
    return { rehearsals: rows.map(summarize) };
  });

  app.post<{ Params: { id: string } }>(
    "/api/plans/:id/execution-rehearsals",
    async (req, reply) => {
      const token = bearerToken(req);
      if (!token) return reply.code(401).send({ error: "unauthenticated" });
      // Strict by contract: IDs, revision, hash and a scenario. Never actions, URLs or faults.
      const body = ExecutionRehearsalRequest.safeParse(req.body);
      if (!body.success || body.data.planId !== req.params.id) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const request = body.data;
      const header = req.headers["idempotency-key"];
      const callerKey = header === undefined ? null : IdempotencyKey.safeParse(header).data;
      if (header !== undefined && callerKey === undefined) {
        return reply.code(400).send({ error: "invalid_idempotency_key" });
      }

      const preview = await loadPlanById(deps.db, request.planId);
      if (preview.kind === "not_found") {
        const person = await requirePerson(deps.iam, token);
        if (!person.ok) return refuse(reply, person, "plan_not_found");
        return reply.code(404).send({ error: "plan_not_found" });
      }
      const orgId = preview.kind === "corrupt" ? preview.orgId : preview.plan.manifest.orgId;
      const gate = await authorize(deps.iam, token, "POST /api/plans/:id/execution-rehearsals", {
        orgId,
      });
      if (!gate.ok) return refuse(reply, gate, "plan_not_found");
      if (preview.kind === "corrupt") {
        req.log.error({ planId: request.planId }, preview.detail);
        return reply.code(500).send({ error: "stored_plan_invalid" });
      }

      if (!supported(request.scenario)) {
        return reply.code(400).send({ error: "unsupported_scenario" });
      }
      const loaded = await loadPlan(deps.db, orgId, request.planId, request.revision);
      if (loaded.kind === "not_found") return reply.code(404).send({ error: "plan_not_found" });
      if (loaded.kind === "corrupt") {
        req.log.error({ planId: request.planId }, loaded.detail);
        return reply.code(500).send({ error: "stored_plan_invalid" });
      }
      if (loaded.plan.planHash !== request.planHash) {
        return reply.code(409).send({ error: "hash_mismatch" });
      }
      // Rehearsing an old revision would describe a plan nobody is about to approve.
      if (loaded.latestRevision !== loaded.plan.revision) {
        return reply
          .code(409)
          .send({ error: "stale_revision", latestRevision: loaded.latestRevision });
      }
      const snapshot = checkSnapshot(loaded.plan.manifest);
      if (!snapshot.ok) {
        return reply.code(422).send({
          error: "unsupported_snapshot",
          detail: snapshot.refusals.slice(0, 3).join("; "),
        });
      }

      const existing = await listRehearsalsForPlan(deps.db, orgId, request.planId);
      const same = existing.filter(
        (s) =>
          s.rehearsal.revision === request.revision &&
          s.rehearsal.planHash === request.planHash &&
          s.rehearsal.scenarioId === request.scenario.id &&
          s.rehearsal.scenarioVersion === request.scenario.version,
      );
      let idempotencyKey: string;
      if (callerKey) idempotencyKey = `hdr:${callerKey}`;
      else {
        // An identical request while one is going, or after one finished recently, is that job.
        const newest = same.at(-1);
        const fresh = newest && finishedAt(newest);
        if (
          newest &&
          (!isTerminal(newest.state) ||
            (newest.state === "completed" &&
              fresh &&
              now().getTime() - fresh.getTime() < REHEARSAL_REPORT_TTL_MS))
        ) {
          return reply.code(200).send({ rehearsal: summarize(newest), existing: true });
        }
        // A failed or cancelled one is never resumed: a retry is a new rehearsal (decision 0013, §5).
        // The attempt number is part of the key, so two racing retries still make exactly one.
        idempotencyKey = `auto:${fingerprint(request)}:${same.length + 1}`;
      }

      const result = await requestRehearsal(deps.db, deps.boss, {
        orgId,
        userId: gate.person.userId,
        idempotencyKey,
        request,
        now: now(),
        newId,
      });
      switch (result.kind) {
        case "not_found":
          return reply.code(404).send({ error: "plan_not_found" });
        case "hash_mismatch":
          return reply.code(409).send({ error: "hash_mismatch" });
        case "unsupported":
          return reply.code(422).send({ error: "unsupported_plan", detail: result.detail });
        case "idempotency_conflict":
          return reply.code(409).send({ error: "idempotency_conflict" });
        case "accepted": {
          const stored = await loadRehearsal(deps.db, orgId, result.rehearsalId);
          if (!stored) return reply.code(500).send({ error: "rehearsal_not_stored" });
          return reply
            .code(result.existing ? 200 : 201)
            .send({ rehearsal: summarize(stored), existing: result.existing });
        }
      }
    },
  );

  // Cancel one that hasn't ended. A queued one is never claimed; a running one sends nothing new
  // and reads back what it already sent, so its report says partial (decision 0013, §5). Final.
  app.post<{ Params: { id: string } }>(
    "/api/execution-rehearsals/:id/cancel",
    async (req, reply) => {
      const token = bearerToken(req);
      if (!token) return reply.code(401).send({ error: "unauthenticated" });
      const orgId = await rehearsalOrgOf(deps.db, req.params.id);
      if (!orgId) {
        const person = await requirePerson(deps.iam, token);
        if (!person.ok) return refuse(reply, person, "rehearsal_not_found");
        return reply.code(404).send({ error: "rehearsal_not_found" });
      }
      const gate = await authorize(deps.iam, token, "POST /api/execution-rehearsals/:id/cancel", {
        orgId,
      });
      if (!gate.ok) return refuse(reply, gate, "rehearsal_not_found");
      const result = await cancelRehearsal(deps.db, orgId, req.params.id, {
        now: now(),
        detail: "Anything it had already sent was read back, not re-sent.",
      });
      req.log.info(
        { rehearsalId: req.params.id, userId: gate.person.userId },
        "rehearsal cancelled",
      );
      const stored = await loadRehearsal(deps.db, orgId, req.params.id);
      if (result === "not_found" || !stored) {
        return reply.code(404).send({ error: "rehearsal_not_found" });
      }
      if (result === "ended") {
        return reply.code(409).send({ error: "rehearsal_ended", rehearsal: summarize(stored) });
      }
      return { rehearsal: summarize(stored) };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/execution-rehearsals/:id/report",
    async (req, reply) => {
      const token = bearerToken(req);
      if (!token) return reply.code(401).send({ error: "unauthenticated" });
      const query = ReportQuery.safeParse(req.query);
      if (!query.success) return reply.code(400).send({ error: "invalid_request" });

      const orgId = await rehearsalOrgOf(deps.db, req.params.id);
      if (!orgId) {
        const person = await requirePerson(deps.iam, token);
        if (!person.ok) return refuse(reply, person, "rehearsal_not_found");
        return reply.code(404).send({ error: "rehearsal_not_found" });
      }
      const gate = await authorize(deps.iam, token, "GET /api/execution-rehearsals/:id/report", {
        orgId,
      });
      if (!gate.ok) return refuse(reply, gate, "rehearsal_not_found");

      const report = await loadRehearsalReport(deps.db, orgId, req.params.id);
      if (!report) return reply.code(404).send({ error: "report_not_found" });

      // Staleness is read against the plan being looked at (the latest revision unless the caller
      // names one), never stored: the report row stays as it was written.
      const latest = await loadPlan(deps.db, orgId, report.plan.planId);
      const viewed =
        query.data.revision === undefined
          ? latest
          : await loadPlan(deps.db, orgId, report.plan.planId, query.data.revision);
      if (latest.kind === "corrupt" || viewed.kind === "corrupt") {
        req.log.error({ rehearsalId: req.params.id }, "stored plan does not match its hash");
        return reply.code(500).send({ error: "stored_plan_invalid" });
      }
      if (latest.kind === "not_found" || viewed.kind === "not_found") {
        return reply.code(404).send({ error: "plan_not_found" });
      }
      const policy =
        viewed.plan.manifest.policies.length === 1 ? viewed.plan.manifest.policies[0] : undefined;
      const stale = rehearsalStaleness(report, {
        latestRevision: latest.plan.revision,
        viewedPlanHash: viewed.plan.planHash,
        policy: policy ?? report.policy,
        versions: deps.currentVersions?.() ?? report.versions,
        now: now(),
      });
      return ExecutionRehearsalReportView.parse({ report, stale });
    },
  );
}
