import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import { CONTRACTS_VERSION, type HealthResponse } from "@rehearsal/contracts";
import Fastify, { type FastifyReply } from "fastify";
import { type ApplyDeps, registerApplyRoute } from "./apply";
import { type ApprovalDeps, registerApprovalRoutes } from "./approvals";
import { registerAuditRoute } from "./audit";
import { type ReviewerResolver, registerMeRoute } from "./auth";
import { registerCancelRoute } from "./cancel";
import { type PlanDeps, registerPlanRoutes } from "./plans";
import { type PrecedentDeps, registerPrecedentRoutes } from "./precedents";
import { type RehearseDeps, registerRehearseRoutes } from "./rehearse";
import { type RunDeps, registerRunRoutes } from "./runs";
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
    approvals?: ApprovalDeps;
    runs?: RunDeps;
    rehearse?: RehearseDeps;
    precedents?: PrecedentDeps;
    /** Clerk-backed in production; without it nobody is signed in. */
    reviewer?: ReviewerResolver;
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
  registerMeRoute(app, deps.reviewer ?? (() => null));

  // Command routes need Postgres; health stays available without it (core mode with no DB).
  // Without it they say "unavailable", not 404, so clients don't mistake an outage for a missing plan.
  const unavailable = async (_req: unknown, reply: FastifyReply) =>
    reply.code(503).send({ error: "database_unavailable" });
  if (deps.apply) {
    registerApplyRoute(app, deps.apply);
    registerCancelRoute(app, deps.apply);
  } else {
    app.post("/api/plans/:id/apply", unavailable);
    app.post("/api/runs/:id/cancel", unavailable);
  }
  if (deps.plans) registerPlanRoutes(app, deps.plans);
  else {
    app.get("/api/plans", unavailable);
    app.get("/api/plans/:id", unavailable);
    app.post("/api/plans/:id/revisions", unavailable);
  }
  if (deps.approvals) registerApprovalRoutes(app, deps.approvals);
  else {
    app.get("/api/plans/:id/approvals", unavailable);
    app.post("/api/plans/:id/approvals", unavailable);
    app.post("/api/plans/:id/approvals/:grantId/revoke", unavailable);
  }
  if (deps.runs) {
    registerRunRoutes(app, deps.runs);
    registerAuditRoute(app, deps.runs);
  } else {
    app.get("/api/runs/:id/events", unavailable);
    app.get("/api/runs/:id/audit", unavailable);
    app.get("/api/plans/:id/runs", unavailable);
  }

  if (deps.precedents) registerPrecedentRoutes(app, deps.precedents);
  else {
    app.post("/api/runs/:id/precedents", unavailable);
    app.post("/api/precedents/:id/withdraw", unavailable);
    app.get("/api/precedents", unavailable);
  }

  if (deps.rehearse) registerRehearseRoutes(app, deps.rehearse);
  else {
    app.post("/api/incidents/:id/rehearse", unavailable);
    app.get("/api/rehearsals/:id", unavailable);
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
