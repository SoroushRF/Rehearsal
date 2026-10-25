import { timingSafeEqual } from "node:crypto";
import { ExecutionRehearsalId } from "@rehearsal/contracts";
import {
  type MintedToken,
  mintTenantToken,
  REHEARSAL_TENANT_TOKEN_ROUTE,
  type RehearsalMintedToken,
  resolveRehearsalWorld,
  WORKER_ROLES,
  type WorldConfig,
} from "@rehearsal/providers";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

/**
 * T1.23: the operator's minter for the execution rehearsal worker (decision 0013 §3). The worker
 * presents REHEARSAL_WORKER_SECRET and names a rehearsal; it gets a token for that rehearsal's
 * `rh-<id>` tenant in the rehearsal containers, and only while the rehearsal is provisioned. It
 * never sees an admin token, and the planner's and executor's secrets don't work here.
 */
export interface RehearsalTokenDeps {
  /** REHEARSAL_ERA_ADMIN_TOKEN: it mints in the rehearsal containers only. */
  adminToken: string;
  secret: string;
  /** Whether this rehearsal is provisioned and not yet torn down (T3.13 stores this). */
  active: (rehearsalId: string) => boolean | Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  mint?: (world: WorldConfig, adminToken: string) => Promise<MintedToken>;
}

const MintRequest = z.strictObject({
  vendor: z.enum(["stripe", "zendesk"]),
  rehearsalId: ExecutionRehearsalId,
});

/** Minter config from the environment, or undefined when rehearsals aren't set up here. */
export function rehearsalTokenDepsFromEnv(
  active: RehearsalTokenDeps["active"],
  env = process.env,
): RehearsalTokenDeps | undefined {
  const adminToken = env.REHEARSAL_ERA_ADMIN_TOKEN;
  const secret = env.REHEARSAL_WORKER_SECRET;
  if (!adminToken || !secret) return undefined;
  const workerSecrets = Object.values(WORKER_ROLES).map(({ secretEnv }) => secretEnv);
  // A secret equal to an admin token would be that admin token under an allowed name, and the
  // worker's startup check only sees names.
  for (const name of ["ERA_ADMIN_TOKEN", "REHEARSAL_ERA_ADMIN_TOKEN", ...workerSecrets]) {
    if (env[name] === secret) throw new Error(`REHEARSAL_WORKER_SECRET must differ from ${name}`);
  }
  for (const name of ["ERA_ADMIN_TOKEN", ...workerSecrets]) {
    if (env[name] === adminToken) {
      throw new Error(`REHEARSAL_ERA_ADMIN_TOKEN must differ from ${name}`);
    }
  }
  return { adminToken, secret, active, env };
}

function presents(authorization: string | undefined, secret: string): boolean {
  const presented = Buffer.from(authorization?.replace(/^Bearer /, "") ?? "");
  const expected = Buffer.from(secret);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export function registerRehearsalTokenRoute(app: FastifyInstance, deps: RehearsalTokenDeps): void {
  const mint = deps.mint ?? mintTenantToken;
  app.post(REHEARSAL_TENANT_TOKEN_ROUTE, async (req, reply) => {
    if (!presents(req.headers.authorization, deps.secret)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const body = MintRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const { vendor, rehearsalId } = body.data;
    if (!(await deps.active(rehearsalId))) {
      return reply.code(409).send({ error: "rehearsal_not_provisioned" });
    }
    let world: WorldConfig;
    try {
      world = resolveRehearsalWorld(vendor, rehearsalId, deps.env);
    } catch (error) {
      req.log.error({ err: error, vendor }, "rehearsal world misconfigured");
      return reply.code(503).send({ error: "rehearsal_world_unavailable" });
    }
    try {
      const minted = await mint(world, deps.adminToken);
      const result: RehearsalMintedToken = {
        ...minted,
        tenant: world.tenant,
        baseUrl: world.baseUrl,
      };
      return result;
    } catch (error) {
      req.log.error({ err: error, vendor, rehearsalId }, "rehearsal token mint failed");
      return reply.code(502).send({ error: "mint_failed" });
    }
  });
}
