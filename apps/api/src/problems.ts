import { randomInt } from "node:crypto";
import { CreateProblem } from "@rehearsal/contracts";
import { orgTenant } from "@rehearsal/core";
import { OrgWorldBusy } from "@rehearsal/db";
import { eraAdmin, resolveWorld } from "@rehearsal/providers";
import { type ProblemRecords, problemRecords } from "@rehearsal/testkit";
import type { FastifyInstance } from "fastify";
import { authorizeCollection, bearerToken, type IamClient, refuse } from "./iam";

/**
 * Live demo (#331): "create a problem" injects a preset's records into the org's planning and
 * operational worlds, so a team can cause the incident it files. Only the API holds the Era admin
 * token, and only preset records go in: the body names a kind and a count, never a record
 * (decision 0015). Without an injector the route isn't registered, so the UI hides the button.
 */
export interface ProblemDeps {
  iam?: IamClient;
  /** Writes the same records into both of the org's worlds. */
  inject: (orgId: string, records: ProblemRecords) => Promise<void>;
  /**
   * Seeds a new org's worlds first (#330). Seeding resets a world that lacks the cohort, so a
   * problem injected before it would be wiped. Absent: nothing is seeded (tests).
   */
  ensureSeeded?: (orgId: string) => Promise<void>;
  /**
   * "Reset my world": back to the seeded cohort. Absent: `POST /api/company/reset` isn't
   * registered. Refused while `busy` says a plan or apply job for the org is still live.
   */
  reset?: (orgId: string) => Promise<void>;
  busy?: (orgId: string) => Promise<boolean>;
}

export function registerProblemRoutes(app: FastifyInstance, deps: ProblemDeps) {
  app.post("/api/company/problems", async (req, reply) => {
    const gate = await authorizeCollection(
      deps.iam,
      bearerToken(req),
      "POST /api/company/problems",
    );
    if (!gate.ok) return refuse(reply, gate, "not_found");
    const body = CreateProblem.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const stamp = `${Date.now().toString(36)}${randomInt(36 ** 3).toString(36)}`;
    const records = problemRecords(
      body.data.preset,
      body.data.count,
      stamp,
      randomInt(9_300_000, 9_900_000),
    );
    if (!records) return reply.code(400).send({ error: "unsupported_preset" });
    try {
      await deps.ensureSeeded?.(gate.person.orgId);
    } catch (err) {
      req.log.error({ err }, "org worlds could not be seeded");
      return reply.code(502).send({ error: "world_unavailable" });
    }
    try {
      await deps.inject(gate.person.orgId, records);
    } catch (err) {
      if (err instanceof OrgWorldBusy) return reply.code(409).send({ error: "work_in_progress" });
      req.log.error({ err, preset: body.data.preset }, "problem inject failed");
      return reply.code(502).send({ error: "inject_failed" });
    }
    return reply.code(204).send();
  });

  const { reset, busy } = deps;
  if (!reset) return;
  app.post("/api/company/reset", async (req, reply) => {
    const gate = await authorizeCollection(deps.iam, bearerToken(req), "POST /api/company/reset");
    if (!gate.ok) return refuse(reply, gate, "not_found");
    const { orgId } = gate.person;
    // A run mid-apply would keep writing into the world being reset.
    if (await busy?.(orgId)) return reply.code(409).send({ error: "work_in_progress" });
    try {
      await reset(orgId);
    } catch (err) {
      if (err instanceof OrgWorldBusy) return reply.code(409).send({ error: "work_in_progress" });
      req.log.error({ err }, "org worlds could not be reset");
      return reply.code(502).send({ error: "world_unavailable" });
    }
    return reply.code(204).send();
  });
}

/**
 * The injector over the Era worlds this API's environment names, into the org's own tenant
 * (`orgTenant(orgId)`, #330) only: no org's problem reaches another org's data.
 */
export function eraProblemInjector(
  env: NodeJS.ProcessEnv = process.env,
): ProblemDeps["inject"] | undefined {
  const adminToken = env.ERA_ADMIN_TOKEN;
  if (!adminToken) return undefined;
  return async (orgId, records) => {
    const tenant = orgTenant(orgId);
    for (const world of ["planning", "operational"] as const) {
      const writes = [
        { vendor: "stripe", body: records.stripe, count: records.stripe.charges.length },
        { vendor: "zendesk", body: records.zendesk, count: records.zendesk.tickets.length },
      ] as const;
      for (const { vendor, body, count } of writes) {
        if (count === 0) continue;
        const res = await eraAdmin(
          resolveWorld(vendor, world, env, tenant),
          adminToken,
          "/inject",
          body,
        );
        if (!res.ok) throw new Error(`${vendor} ${world} inject → ${res.status}`);
      }
    }
  };
}
