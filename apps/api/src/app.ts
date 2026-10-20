import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import { CONTRACTS_VERSION, type HealthResponse } from "@rehearsal/contracts";
import Fastify from "fastify";

const webDist = fileURLToPath(new URL("../../web/dist/", import.meta.url));

/**
 * HTTP commands store intent and return IDs; long-running work happens in the workers.
 * Clerk auth and the plan/approval/apply routes land here (owner: C).
 */
export function buildApp() {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  app.get(
    "/api/health",
    async (): Promise<HealthResponse> => ({
      ok: true,
      mode: "core",
      contractsVersion: CONTRACTS_VERSION,
    }),
  );

  // Serve the built web app from the same origin in production.
  if (existsSync(webDist)) {
    app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply.code(404).send({ error: "not_found" })
        : reply.sendFile("index.html"),
    );
  }

  return app;
}
