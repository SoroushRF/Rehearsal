import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import { CONTRACTS_VERSION, type HealthResponse } from "@rehearsal/contracts";
import Fastify, { type FastifyReply } from "fastify";
import { type ApplyDeps, registerApplyRoute } from "./apply";
import { type PlanDeps, registerPlanRoutes } from "./plans";
import { registerTenantTokenRoute, type TenantTokenDeps } from "./tenant-tokens";

const webDist = fileURLToPath(new URL("../../web/dist/", import.meta.url));

/**
 * HTTP commands store intent and return IDs; long-running work happens in the workers.
 * Clerk auth and the plan/approval/apply routes land here (owner: C).
 */
export function buildApp(
  deps: {
    apply?: ApplyDeps;
    plans?: PlanDeps;
    tenantTokens?: TenantTokenDeps;
    webRoot?: string | null;
  } = {},
) {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  app.get(
    "/api/health",
    async (): Promise<HealthResponse> => ({
      ok: true,
      mode: "core",
      contractsVersion: CONTRACTS_VERSION,
    }),
  );

  // Command routes need Postgres; health stays available without it (core mode with no DB).
  // Without it they say "unavailable", not 404, so clients don't mistake an outage for a missing plan.
  const unavailable = async (_req: unknown, reply: FastifyReply) =>
    reply.code(503).send({ error: "database_unavailable" });
  if (deps.apply) registerApplyRoute(app, deps.apply);
  else app.post("/api/plans/:id/apply", unavailable);
  if (deps.plans) registerPlanRoutes(app, deps.plans);
  else {
    app.get("/api/plans", unavailable);
    app.get("/api/plans/:id", unavailable);
    app.post("/api/plans/:id/revisions", unavailable);
  }

  // Only an API that holds ERA_ADMIN_TOKEN mints tenant tokens for the workers.
  if (deps.tenantTokens) registerTenantTokenRoute(app, deps.tenantTokens);

  // Serve the built web app from the same origin in production.
  const root = deps.webRoot === undefined ? webDist : deps.webRoot;
  if (root && existsSync(root)) {
    app.register(fastifyStatic, { root });
    app.setNotFoundHandler((req, reply) => {
      const path = new URL(req.url, "http://localhost").pathname;
      const navigation =
        (req.method === "GET" || req.method === "HEAD") &&
        req.headers.accept?.includes("text/html") &&
        !/^\/(api|internal)(\/|$)/.test(path);
      return navigation
        ? reply.sendFile("index.html")
        : reply.code(404).send({ error: "not_found" });
    });
  }

  return app;
}
