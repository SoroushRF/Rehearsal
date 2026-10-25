import {
  approvePrecedent,
  type Db,
  enqueuePrecedentSync,
  latestApproved,
  loadRegistry,
  type PgBoss,
  schema,
} from "@rehearsal/db";
import { PrecedentId, PrecedentRecord, precedentDigest } from "@rehearsal/memory";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ReviewerResolver } from "./auth";
import type { Outcome } from "./plans";

const { runs } = schema;

export interface PrecedentDeps {
  db: Db;
  boss: PgBoss;
  reviewer: ReviewerResolver;
  /** Whether Agent Memory is configured. Without it a promotion waits; the list says so. */
  syncEnabled: boolean;
  now?: () => Date;
}

const NonBlank = z.string().refine((s) => s.trim().length > 0, "must not be blank");

/**
 * What a finance lead specifies. Everything else (author, role, version, approval time) is set
 * here from the verified user and the registry, never taken from the browser.
 */
export const PromoteRequest = z.strictObject({
  id: PrecedentId,
  appliesTo: z
    .string()
    .regex(/^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/, "appliesTo must be dotted lowercase"),
  statement: NonBlank,
  conditions: z.array(NonBlank),
  exceptions: z.array(NonBlank),
  effectiveFrom: z.iso.date(),
  effectiveUntil: z.iso.date().nullable(),
});

/**
 * Promoting a case to a precedent (decision 0012). Finance only, from a completed run. It records
 * the approved version and queues its sync to Agent Memory in one transaction; the precedent is
 * "waiting" until the sync has read it back, and nothing plans from it before then.
 */
export function registerPrecedentRoutes(app: FastifyInstance, deps: PrecedentDeps) {
  const now = () => deps.now?.() ?? new Date();

  app.post<{ Params: { id: string } }>("/api/runs/:id/precedents", async (req, reply) => {
    const me = await deps.reviewer(req);
    if (!me) return reply.code(401).send({ error: "unauthenticated" });
    if (!me.roles.includes("finance_lead")) {
      return reply
        .code(403)
        .send({ error: "missing_roles", missing: ["finance_lead"], held: me.roles });
    }
    const body = PromoteRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });

    const out = await deps.db.transaction(async (tx): Promise<Outcome> => {
      const [run] = await tx
        .select({ state: runs.state })
        .from(runs)
        .where(and(eq(runs.orgId, me.orgId), eq(runs.id, req.params.id)));
      if (!run) return [404, { error: "run_not_found" }];
      if (run.state !== "completed") {
        return [409, { error: "run_not_completed", state: run.state }];
      }

      const latest = await latestApproved(tx, me.orgId, body.data.id);
      if (latest && latest.appliesTo !== body.data.appliesTo) {
        return [409, { error: "area_changed", appliesTo: latest.appliesTo }];
      }
      const version = (latest?.version ?? 0) + 1;

      const record = PrecedentRecord.safeParse({
        ...body.data,
        version,
        author: { userId: me.userId, role: "finance_lead" },
        approvedAt: now().toISOString(),
      });
      if (!record.success) {
        return [
          422,
          { error: "invalid_precedent", issues: record.error.issues.map((i) => i.message) },
        ];
      }

      const stored = await approvePrecedent(tx, {
        orgId: me.orgId,
        precedentId: record.data.id,
        version,
        appliesTo: record.data.appliesTo,
        digest: precedentDigest(record.data),
        record: record.data,
        actorUserId: me.userId,
        sourceRunId: req.params.id,
      });
      // Two promotions racing for the same version: the loser tries again against the new latest.
      if (!stored) return [409, { error: "conflict" }];
      await enqueuePrecedentSync(deps.boss, tx, {
        orgId: me.orgId,
        precedentId: record.data.id,
        version,
      });
      return [
        201,
        {
          precedent: {
            id: record.data.id,
            version,
            appliesTo: record.data.appliesTo,
            status: "waiting",
          },
          syncEnabled: deps.syncEnabled,
        },
      ];
    });
    return reply.code(out[0]).send(out[1]);
  });

  /** Every version this organization has approved, with where it stands. Any signed-in member. */
  app.get("/api/precedents", async (req, reply) => {
    const me = await deps.reviewer(req);
    if (!me) return reply.code(401).send({ error: "unauthenticated" });
    const { entries } = await loadRegistry(deps.db, me.orgId);
    const precedents = entries.flatMap((e) => {
      const record = PrecedentRecord.safeParse(e.record);
      if (!record.success) return [];
      const r = record.data;
      return [
        {
          id: e.id,
          version: e.version,
          appliesTo: e.appliesTo,
          status: e.status,
          statement: r.statement,
          conditions: r.conditions,
          exceptions: r.exceptions,
          effectiveFrom: r.effectiveFrom,
          effectiveUntil: r.effectiveUntil,
          author: r.author.userId,
          approvedAt: r.approvedAt,
          sourceRunId: e.sourceRunId,
        },
      ];
    });
    return { precedents, syncEnabled: deps.syncEnabled };
  });
}
