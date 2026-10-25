import { timingSafeEqual } from "node:crypto";
import {
  type MintedToken,
  mintTenantToken,
  resolveWorld,
  TENANT_TOKEN_ROUTE,
  WORKER_ROLES,
  type WorkerRole,
  type WorldConfig,
} from "@rehearsal/providers";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

/**
 * Operator-side minter. The API is the only process holding ERA_ADMIN_TOKEN; each worker presents
 * its own secret and gets a signed tenant token for its own world only (planner → planning,
 * executor → operational). See docs/decisions/0002-era-tenant-token-minting.md.
 */
export interface TenantTokenDeps {
  adminToken: string;
  secrets: Partial<Record<WorkerRole, string>>;
  env?: NodeJS.ProcessEnv;
  mint?: (world: WorldConfig, adminToken: string) => Promise<MintedToken>;
}

const MintRequest = z.object({ vendor: z.enum(["stripe", "zendesk"]) });

/** Minter config from the environment, or undefined when this API is not the operator. */
export function tenantTokenDepsFromEnv(env = process.env): TenantTokenDeps | undefined {
  const adminToken = env.ERA_ADMIN_TOKEN;
  if (!adminToken) return undefined;
  const secrets = {
    planner: env[WORKER_ROLES.planner.secretEnv],
    executor: env[WORKER_ROLES.executor.secretEnv],
  };
  // One shared secret would let the planner mint operational tokens.
  if (secrets.planner && secrets.planner === secrets.executor) {
    throw new Error("PLANNER_WORKER_SECRET and EXECUTOR_WORKER_SECRET must differ");
  }
  // A worker secret equal to the admin token would hand a worker the admin token itself.
  for (const { secretEnv } of Object.values(WORKER_ROLES)) {
    if (env[secretEnv] === adminToken)
      throw new Error(`${secretEnv} must differ from ERA_ADMIN_TOKEN`);
  }
  return { adminToken, secrets, env };
}

/** The worker whose secret this bearer token is, compared in constant time. */
export function workerRole(
  authorization: string | undefined,
  secrets: Partial<Record<WorkerRole, string>>,
): WorkerRole | undefined {
  const presented = Buffer.from(authorization?.replace(/^Bearer /, "") ?? "");
  for (const role of Object.keys(WORKER_ROLES) as WorkerRole[]) {
    const secret = secrets[role];
    if (!secret) continue;
    const expected = Buffer.from(secret);
    if (presented.length === expected.length && timingSafeEqual(presented, expected)) return role;
  }
  return undefined;
}

export function registerTenantTokenRoute(app: FastifyInstance, deps: TenantTokenDeps): void {
  const mint = deps.mint ?? mintTenantToken;
  app.post(TENANT_TOKEN_ROUTE, async (req, reply) => {
    const role = workerRole(req.headers.authorization, deps.secrets);
    if (!role) return reply.code(401).send({ error: "unauthorized" });
    const body = MintRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const world = resolveWorld(body.data.vendor, WORKER_ROLES[role].world, deps.env);
    try {
      return await mint(world, deps.adminToken);
    } catch (error) {
      req.log.error({ err: error, role, vendor: body.data.vendor }, "tenant token mint failed");
      return reply.code(502).send({ error: "mint_failed" });
    }
  });
}
