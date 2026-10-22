import { CreateRevisionRequest, PlanManifest } from "@rehearsal/contracts";
import { excludeActions, planHash } from "@rehearsal/core";
import { type Db, schema } from "@rehearsal/db";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthResolver } from "./apply";

const { planVersions } = schema;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface PlanDeps {
  db: Db;
  auth: AuthResolver;
}

export interface StoredPlan {
  planId: string;
  revision: number;
  planHash: string;
  manifest: PlanManifest;
  createdAt: string;
}

export type Load =
  | { kind: "found"; plan: StoredPlan; latestRevision: number }
  | { kind: "not_found" }
  | { kind: "corrupt"; detail: string };

/**
 * Stores a validated manifest as a new revision under its own org and plan ID. Plans arrive from
 * the planner worker or a seed script, never from the browser. Returns null if the revision
 * already exists.
 */
export async function storePlan(db: Db, manifest: unknown): Promise<{ planHash: string } | null> {
  const parsed = PlanManifest.parse(manifest);
  const hash = planHash(parsed);
  const [row] = await db
    .insert(planVersions)
    .values({
      orgId: parsed.orgId,
      planId: parsed.planId,
      revision: parsed.revision,
      planHash: hash,
      manifest: parsed,
    })
    .onConflictDoNothing()
    .returning({ planHash: planVersions.planHash });
  return row ?? null;
}

/**
 * Loads one revision (the latest if none is given) and re-verifies it. A row whose manifest
 * doesn't match its own keys or hash is never served as if it were the approved content.
 */
export async function loadPlan(
  db: Db | Tx,
  orgId: string,
  planId: string,
  revision?: number,
): Promise<Load> {
  const rows = await db
    .select()
    .from(planVersions)
    .where(and(eq(planVersions.orgId, orgId), eq(planVersions.planId, planId)))
    .orderBy(desc(planVersions.revision));
  const latest = rows[0];
  const row = revision === undefined ? latest : rows.find((r) => r.revision === revision);
  if (!latest || !row) return { kind: "not_found" };

  const manifest = PlanManifest.safeParse(row.manifest);
  if (
    !manifest.success ||
    manifest.data.orgId !== orgId ||
    manifest.data.planId !== planId ||
    manifest.data.revision !== row.revision ||
    planHash(manifest.data) !== row.planHash
  ) {
    return { kind: "corrupt", detail: `revision ${row.revision} does not match its row or hash` };
  }
  return {
    kind: "found",
    plan: {
      planId,
      revision: row.revision,
      planHash: row.planHash,
      manifest: manifest.data,
      createdAt: row.createdAt.toISOString(),
    },
    latestRevision: latest.revision,
  };
}

const RevisionQuery = z.object({ revision: z.coerce.number().int().positive().optional() });

/**
 * Read routes return the server's own stored copy with its hash. The only way to change a plan
 * is a new revision that excludes actions; the browser names them by ID and never sends bodies.
 */
export function registerPlanRoutes(app: FastifyInstance, deps: PlanDeps) {
  app.get("/api/plans", async (req, reply) => {
    const auth = await deps.auth(req);
    if (!auth) return reply.code(401).send({ error: "unauthenticated" });

    const rows = await deps.db
      .select({
        planId: planVersions.planId,
        revision: planVersions.revision,
        planHash: planVersions.planHash,
        incidentId: sql<string>`${planVersions.manifest}->>'incidentId'`,
        createdAt: planVersions.createdAt,
      })
      .from(planVersions)
      .where(eq(planVersions.orgId, auth.orgId))
      .orderBy(desc(planVersions.createdAt), desc(planVersions.revision));

    // Newest revision of each plan, newest plan first.
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const seen = latest.get(r.planId);
      if (!seen || r.revision > seen.revision) latest.set(r.planId, r);
    }
    return {
      plans: [...latest.values()].map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    };
  });

  app.get<{ Params: { id: string } }>("/api/plans/:id", async (req, reply) => {
    const auth = await deps.auth(req);
    if (!auth) return reply.code(401).send({ error: "unauthenticated" });
    const query = RevisionQuery.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_request" });

    const loaded = await loadPlan(deps.db, auth.orgId, req.params.id, query.data.revision);
    switch (loaded.kind) {
      case "not_found":
        return reply.code(404).send({ error: "plan_not_found" });
      case "corrupt":
        req.log.error({ planId: req.params.id }, loaded.detail);
        return reply.code(500).send({ error: "stored_plan_invalid" });
      case "found":
        return { ...loaded.plan, latestRevision: loaded.latestRevision };
    }
  });

  app.post<{ Params: { id: string } }>("/api/plans/:id/revisions", async (req, reply) => {
    const auth = await deps.auth(req);
    if (!auth) return reply.code(401).send({ error: "unauthenticated" });
    // Strict: only IDs, the base revision and its hash. Never action bodies.
    const body = CreateRevisionRequest.strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const { baseRevision, basePlanHash, excludeActionIds } = body.data;

    return deps.db.transaction(async (tx) => {
      const loaded = await loadPlan(tx, auth.orgId, req.params.id, baseRevision);
      if (loaded.kind === "not_found") return reply.code(404).send({ error: "plan_not_found" });
      if (loaded.kind === "corrupt") {
        req.log.error({ planId: req.params.id }, loaded.detail);
        return reply.code(500).send({ error: "stored_plan_invalid" });
      }
      const base = loaded.plan;
      if (base.planHash !== basePlanHash) {
        return reply.code(409).send({ error: "hash_mismatch" });
      }
      // Revisions form a line, not a tree: editing an older revision would silently fork it.
      if (loaded.latestRevision !== base.revision) {
        return reply
          .code(409)
          .send({ error: "stale_revision", latestRevision: loaded.latestRevision });
      }

      const known = new Set(base.manifest.actions.map((a) => a.id));
      const unknown = [...new Set(excludeActionIds)].filter((id) => !known.has(id));
      if (unknown.length > 0) {
        return reply.code(400).send({ error: "unknown_actions", actionIds: unknown });
      }

      const next = excludeActions(base.manifest, excludeActionIds);
      const hash = planHash(next);
      const [inserted] = await tx
        .insert(planVersions)
        .values({
          orgId: auth.orgId,
          planId: base.planId,
          revision: next.revision,
          planHash: hash,
          manifest: next,
        })
        .onConflictDoNothing()
        .returning({ createdAt: planVersions.createdAt });
      if (!inserted) {
        // A concurrent request created this revision first.
        return reply.code(409).send({ error: "stale_revision", latestRevision: next.revision });
      }

      const before = new Set(base.manifest.excluded.map((e) => e.actionId));
      return reply.code(201).send({
        planId: base.planId,
        revision: next.revision,
        parentRevision: base.revision,
        planHash: hash,
        manifest: next,
        createdAt: inserted.createdAt.toISOString(),
        dropped: next.excluded.filter((e) => !before.has(e.actionId)),
      });
    });
  });
}
