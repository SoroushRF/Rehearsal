import {
  approvePrecedent,
  type Db,
  enqueuePrecedentSync,
  latestApproved,
  loadRegistry,
  lockPrecedent,
  type PgBoss,
  recordPrecedentEvent,
  schema,
} from "@rehearsal/db";
import { PrecedentId, PrecedentRecord, precedentDigest } from "@rehearsal/memory";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  authorize,
  authorizeCollection,
  bearerToken,
  type IamClient,
  refuse,
  requirePerson,
} from "./iam";
import type { Outcome } from "./plans";

const { runs } = schema;

export interface PrecedentDeps {
  db: Db;
  boss: PgBoss;
  iam?: IamClient;
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
 * Which version the finance lead saw as active. Like an approval's hash, it stops a stale page from
 * withdrawing a newer version nobody looked at.
 */
export const WithdrawRequest = z.strictObject({ version: z.int().positive() });

/**
 * This organization's stored copy of the precedent. The id is reused across organizations, so a
 * row in some other org is not this one. The org sent to IAM is the one on the stored row.
 */
async function storedPrecedentOrg(
  db: Db,
  orgId: string,
  precedentId: string,
): Promise<string | null> {
  const rows = await db
    .select({ orgId: schema.precedentEvents.orgId })
    .from(schema.precedentEvents)
    .where(
      and(
        eq(schema.precedentEvents.orgId, orgId),
        eq(schema.precedentEvents.precedentId, precedentId),
      ),
    );
  return rows.find((row) => row.orgId === orgId)?.orgId ?? null;
}

/**
 * Promoting a case to a precedent (decision 0012). Finance only, from a completed run. It records
 * the approved version and queues its sync to Agent Memory in one transaction; the precedent is
 * "waiting" until the sync has read it back, and nothing plans from it before then.
 */
export function registerPrecedentRoutes(app: FastifyInstance, deps: PrecedentDeps) {
  const now = () => deps.now?.() ?? new Date();

  app.post<{ Params: { id: string } }>("/api/runs/:id/precedents", async (req, reply) => {
    const token = bearerToken(req);
    if (!token) return reply.code(401).send({ error: "unauthenticated" });
    const body = PromoteRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });

    const [run] = await deps.db.select().from(runs).where(eq(runs.id, req.params.id));
    if (!run) {
      const person = await requirePerson(deps.iam, token);
      if (!person.ok) return refuse(reply, person, "run_not_found");
      return reply.code(404).send({ error: "run_not_found" });
    }
    const gate = await authorize(deps.iam, token, "POST /api/runs/:id/precedents", {
      orgId: run.orgId,
    });
    if (!gate.ok) return refuse(reply, gate, "run_not_found");

    const out = await deps.db.transaction(async (tx): Promise<Outcome> => {
      const [current] = await tx
        .select({ state: runs.state, orgId: runs.orgId })
        .from(runs)
        .where(eq(runs.id, req.params.id));
      if (!current || current.orgId !== run.orgId) return [404, { error: "run_not_found" }];
      if (current.state !== "completed") {
        return [409, { error: "run_not_completed", state: current.state }];
      }

      const latest = await latestApproved(tx, run.orgId, body.data.id);
      if (latest && latest.appliesTo !== body.data.appliesTo) {
        return [409, { error: "area_changed", appliesTo: latest.appliesTo }];
      }
      const version = (latest?.version ?? 0) + 1;

      const record = PrecedentRecord.safeParse({
        ...body.data,
        version,
        author: { userId: gate.person.userId, role: "finance_lead" },
        approvedAt: now().toISOString(),
      });
      if (!record.success) {
        return [
          422,
          { error: "invalid_precedent", issues: record.error.issues.map((i) => i.message) },
        ];
      }

      const stored = await approvePrecedent(tx, {
        orgId: run.orgId,
        precedentId: record.data.id,
        version,
        appliesTo: record.data.appliesTo,
        digest: precedentDigest(record.data),
        record: record.data,
        actorUserId: gate.person.userId,
        sourceRunId: req.params.id,
      });
      // Two promotions racing for the same version: the loser tries again against the new latest.
      if (!stored) return [409, { error: "conflict" }];
      await enqueuePrecedentSync(deps.boss, tx, {
        orgId: run.orgId,
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

  /**
   * Withdraws the active version (finance only). History isn't edited: a `withdrawn` event is
   * appended, the precedent leaves the registry snapshot and its area's epoch moves, so any plan
   * that relied on it is held once admission checks citations. A newer version that is still
   * waiting is a separate approval and becomes active if its sync completes.
   */
  app.post<{ Params: { id: string } }>("/api/precedents/:id/withdraw", async (req, reply) => {
    const token = bearerToken(req);
    if (!token) return reply.code(401).send({ error: "unauthenticated" });
    const person = await requirePerson(deps.iam, token);
    if (!person.ok) return refuse(reply, person, "precedent_not_found");
    const body = WithdrawRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const id = req.params.id;
    const orgId = await storedPrecedentOrg(deps.db, person.person.orgId, id);
    if (!orgId) return reply.code(404).send({ error: "precedent_not_found" });
    const gate = await authorize(deps.iam, token, "POST /api/precedents/:id/withdraw", { orgId });
    if (!gate.ok) return refuse(reply, gate, "precedent_not_found");

    const out = await deps.db.transaction(async (tx): Promise<Outcome> => {
      await lockPrecedent(tx, orgId, id);
      const { snapshot, entries } = await loadRegistry(tx, orgId);
      if (!entries.some((e) => e.id === id)) return [404, { error: "precedent_not_found" }];
      const active = snapshot.active.get(id);
      if (!active) return [409, { error: "not_active" }];
      if (active.version !== body.data.version) {
        return [409, { error: "stale_version", activeVersion: active.version }];
      }
      await recordPrecedentEvent(tx, {
        orgId,
        precedentId: id,
        version: active.version,
        kind: "withdrawn",
        actorUserId: gate.person.userId,
      });
      return [200, { precedent: { id, version: active.version, status: "withdrawn" } }];
    });
    return reply.code(out[0]).send(out[1]);
  });

  /** Every version this organization has approved, with where it stands. */
  app.get("/api/precedents", async (req, reply) => {
    const gate = await authorizeCollection(deps.iam, bearerToken(req), "GET /api/precedents");
    if (!gate.ok) return refuse(reply, gate, "precedent_not_found");
    const { entries } = await loadRegistry(deps.db, gate.person.orgId);
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
