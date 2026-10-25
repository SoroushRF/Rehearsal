import type { FastifyInstance } from "fastify";
import { bearerToken, type IamClient } from "./iam";

/**
 * `GET /api/me` has no product rule. IAM verifies the bearer token and returns the person plus the
 * permissions the loaded rule file gives their Clerk role. The API does not hold the Clerk secret.
 */
export function registerMeRoute(app: FastifyInstance, iam?: IamClient) {
  app.get("/api/me", async (req, reply) => {
    const token = bearerToken(req);
    if (!token) return reply.code(401).send({ error: "unauthenticated" });
    if (!iam) return reply.code(503).send({ error: "iam_unavailable" });
    const identified = await iam.identify(token);
    if (identified.kind === "unavailable")
      return reply.code(503).send({ error: "iam_unavailable" });
    if (identified.kind !== "ok") return reply.code(401).send({ error: "unauthenticated" });
    const { userId, orgId, clerkRole, permissions } = identified.person;
    return { userId, orgId, clerkRole, permissions };
  });
}
