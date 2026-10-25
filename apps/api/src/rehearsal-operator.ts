import { ExecutionRehearsalId, PlanManifest } from "@rehearsal/contracts";
import { planHash, snapshotDigest } from "@rehearsal/core";
import {
  type Db,
  loadRehearsal,
  rehearsalInFlight,
  rehearsalMarkedDirty,
  rehearsalOrgOf,
  schema,
} from "@rehearsal/db";
import {
  REHEARSAL_CHALLENGE_ROUTE,
  REHEARSAL_PROVISION_ROUTE,
  REHEARSAL_TEARDOWN_ROUTE,
} from "@rehearsal/providers";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { applyRehearsalChallenges } from "../../../scripts/inject/challenge";
import {
  type Provisioned,
  provisionSnapshot,
  teardownSnapshot,
  verifySnapshot,
} from "../../../scripts/seed/snapshot";
import { presents } from "./rehearsal-tokens";

/**
 * T3.16: the operator side of a rehearsal's tenants (decision 0013 §3). The rehearsal worker holds
 * no admin token, so it asks here, with REHEARSAL_WORKER_SECRET, naming only the rehearsal:
 *
 * - provision: the rehearsal must be claimed (`provisioning`). The plan is loaded from storage
 *   and checked against the rehearsal's hash and snapshot digest; its own evidence is seeded into
 *   the `rh-<id>` tenants and read back; a mismatch refuses the run (§4). The answer is what was
 *   seeded from outside the evidence, never a token.
 * - teardown: the rehearsal must have ended with no send in flight; its tenants are reset.
 * - challenge (T3.16): apply its own allowlisted scenario, bound to the stored plan, to its own
 *   tenant: the inject before the run (claimed, and its set already marked dirty), or the teammate
 *   edit once the named step has been rejected (running). The caller names a phase and a step,
 *   never a record, a body or a fault.
 *
 * Everything is derived from the stored rehearsal: the caller can't name a tenant, a plan or a URL.
 */
export interface RehearsalOperatorDeps {
  db: Db;
  /** REHEARSAL_WORKER_SECRET. */
  secret: string;
  provision?: (manifest: PlanManifest, rehearsalId: string) => Promise<Provisioned>;
  teardown?: (rehearsalId: string, state: "completed" | "failed" | "cancelled") => Promise<unknown>;
  challenge?: typeof applyRehearsalChallenges;
}

const ChallengeRequest = z.strictObject({
  phase: z.enum(["before_run", "after_rejected"]),
  actionId: z.string().min(1).max(128).optional(),
});

/** Whether the worker may hold this rehearsal's tenant tokens: claimed, and not yet reset. */
export async function rehearsalTenantActive(db: Db, rehearsalId: string): Promise<boolean> {
  const id = ExecutionRehearsalId.safeParse(rehearsalId);
  if (!id.success) return false;
  const orgId = await rehearsalOrgOf(db, id.data);
  const stored = orgId ? await loadRehearsal(db, orgId, id.data) : null;
  return !!stored && stored.state !== "queued" && !stored.tornDown;
}

/** Seed the snapshot, then read the tenants back before anything runs. */
export async function seedAndVerify(
  manifest: PlanManifest,
  rehearsalId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Provisioned> {
  const seeded = await provisionSnapshot(manifest, rehearsalId, env);
  if (!seeded.ok) return seeded;
  const check = await verifySnapshot(manifest, seeded.worlds);
  return check.ok ? seeded : { ok: false, refusals: check.mismatches };
}

export function registerRehearsalOperatorRoutes(
  app: FastifyInstance,
  deps: RehearsalOperatorDeps,
): void {
  const provision = deps.provision ?? seedAndVerify;
  const teardown = deps.teardown ?? ((id, state) => teardownSnapshot(id, state));

  async function stored(id: string) {
    const parsed = ExecutionRehearsalId.safeParse(id);
    if (!parsed.success) return null;
    const orgId = await rehearsalOrgOf(deps.db, parsed.data);
    return orgId ? loadRehearsal(deps.db, orgId, parsed.data) : null;
  }

  app.post<{ Params: { id: string } }>(REHEARSAL_PROVISION_ROUTE, async (req, reply) => {
    if (!presents(req.headers.authorization, deps.secret)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const found = await stored(req.params.id);
    if (!found) return reply.code(404).send({ error: "rehearsal_not_found" });
    if (found.state !== "provisioning") {
      return reply.code(409).send({ error: "rehearsal_not_claimed", state: found.state });
    }
    const r = found.rehearsal;
    const [plan] = await deps.db
      .select()
      .from(schema.planVersions)
      .where(
        and(
          eq(schema.planVersions.orgId, r.orgId),
          eq(schema.planVersions.planId, r.planId),
          eq(schema.planVersions.revision, r.revision),
        ),
      );
    const manifest = PlanManifest.safeParse(plan?.manifest);
    if (
      !plan ||
      !manifest.success ||
      plan.planHash !== r.planHash ||
      planHash(manifest.data) !== r.planHash ||
      snapshotDigest(manifest.data) !== r.snapshotDigest
    ) {
      return reply.code(409).send({ error: "plan_does_not_match_rehearsal" });
    }
    try {
      const result = await provision(manifest.data, r.id);
      if (!result.ok) return reply.code(422).send({ ok: false, refusals: result.refusals });
      return { ok: true, notFromEvidence: result.notFromEvidence };
    } catch (error) {
      req.log.error({ err: error, rehearsalId: r.id }, "rehearsal provisioning failed");
      return reply.code(502).send({ error: "provision_failed" });
    }
  });

  app.post<{ Params: { id: string } }>(REHEARSAL_TEARDOWN_ROUTE, async (req, reply) => {
    if (!presents(req.headers.authorization, deps.secret)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const found = await stored(req.params.id);
    if (!found) return reply.code(404).send({ error: "rehearsal_not_found" });
    const state = found.state;
    if (state !== "completed" && state !== "failed" && state !== "cancelled") {
      return reply.code(409).send({ error: "rehearsal_not_ended", state });
    }
    // A send whose outcome is unknown keeps the tenant: it is read again before any reset.
    if ((await rehearsalInFlight(deps.db, found.rehearsal.orgId, found.rehearsal.id)).length > 0) {
      return reply.code(409).send({ error: "send_in_flight" });
    }
    try {
      await teardown(found.rehearsal.id, state);
      return { ok: true };
    } catch (error) {
      req.log.error({ err: error, rehearsalId: found.rehearsal.id }, "rehearsal teardown failed");
      return reply.code(502).send({ error: "teardown_failed" });
    }
  });

  app.post<{ Params: { id: string } }>(REHEARSAL_CHALLENGE_ROUTE, async (req, reply) => {
    if (!presents(req.headers.authorization, deps.secret)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const body = ChallengeRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const found = await stored(req.params.id);
    if (!found) return reply.code(404).send({ error: "rehearsal_not_found" });
    const r = found.rehearsal;
    const { phase, actionId } = body.data;
    if (phase === "before_run") {
      if (found.state !== "provisioning") {
        return reply.code(409).send({ error: "rehearsal_not_claimed", state: found.state });
      }
      // The mark goes down before the first inject, so a crash can't leave a challenged set
      // looking clean (decision 0013 §3).
      if (!(await rehearsalMarkedDirty(deps.db, r.id))) {
        return reply.code(409).send({ error: "container_set_not_marked" });
      }
    } else {
      if (found.state !== "running") {
        return reply.code(409).send({ error: "rehearsal_not_running", state: found.state });
      }
      if (!actionId) return reply.code(400).send({ error: "invalid_request" });
      // Only once that step was actually rejected in this rehearsal.
      const attempts = await deps.db
        .select({ state: schema.rehearsalAttempts.state })
        .from(schema.rehearsalAttempts)
        .where(
          and(
            eq(schema.rehearsalAttempts.orgId, r.orgId),
            eq(schema.rehearsalAttempts.rehearsalId, r.id),
            eq(schema.rehearsalAttempts.actionId, actionId),
          ),
        );
      if (!attempts.some((a) => a.state === "rejected")) {
        return reply.code(409).send({ error: "step_not_rejected" });
      }
    }
    const plan = await storedPlanOf(deps.db, r);
    if (!plan) return reply.code(409).send({ error: "plan_does_not_match_rehearsal" });
    try {
      const result = await (deps.challenge ?? applyRehearsalChallenges)({
        rehearsalId: r.id,
        manifest: plan,
        scenario: { id: r.scenarioId as never, version: r.scenarioVersion },
        phase,
        ...(actionId ? { actionId } : {}),
      });
      return { applied: result.applied };
    } catch (error) {
      req.log.error({ err: error, rehearsalId: r.id, phase }, "rehearsal challenge failed");
      return reply.code(502).send({ error: "challenge_failed" });
    }
  });
}

/** The rehearsal's exact stored plan, or null when it no longer matches the rehearsal's bindings. */
async function storedPlanOf(
  db: Db,
  r: { orgId: string; planId: string; revision: number; planHash: string; snapshotDigest: string },
): Promise<PlanManifest | null> {
  const [plan] = await db
    .select()
    .from(schema.planVersions)
    .where(
      and(
        eq(schema.planVersions.orgId, r.orgId),
        eq(schema.planVersions.planId, r.planId),
        eq(schema.planVersions.revision, r.revision),
      ),
    );
  const manifest = PlanManifest.safeParse(plan?.manifest);
  if (
    !plan ||
    !manifest.success ||
    plan.planHash !== r.planHash ||
    planHash(manifest.data) !== r.planHash ||
    snapshotDigest(manifest.data) !== r.snapshotDigest
  ) {
    return null;
  }
  return manifest.data;
}
