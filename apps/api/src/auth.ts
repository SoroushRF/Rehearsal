import { createClerkClient } from "@clerk/backend";
import type { Role } from "@rehearsal/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthContext } from "./apply";

/** A signed-in reviewer acting inside one organization, as verified by the server. */
export interface Reviewer extends AuthContext {
  sessionId: string;
  /** Rehearsal roles this org membership holds. Empty means the member can read but not approve. */
  roles: Role[];
}
export type ReviewerResolver = (req: FastifyRequest) => Reviewer | null | Promise<Reviewer | null>;

/**
 * Clerk organization roles, mapped to Rehearsal roles. A finance lead also holds `support_lead`,
 * so one finance approval covers a whole plan; executor admission requires the grant to hold
 * every role the plan needs. Any other org role can read plans and approve nothing.
 */
export const CLERK_ROLES: Readonly<Record<string, readonly Role[]>> = {
  "org:finance_lead": ["finance_lead", "support_lead"],
  "org:support_lead": ["support_lead"],
};

/** The verified session claims we use. Tests stand in for Clerk at this seam. */
export interface SessionClaims {
  userId: string;
  sessionId: string;
  orgId: string | null;
  orgRole: string | null;
}
export type Authenticate = (req: Request) => Promise<SessionClaims | null>;

export function reviewerFrom(claims: SessionClaims | null): Reviewer | null {
  // Everything is org-scoped, so a session without an active organization can see nothing.
  if (!claims?.orgId) return null;
  return {
    userId: claims.userId,
    orgId: claims.orgId,
    sessionId: claims.sessionId,
    roles: [...(CLERK_ROLES[claims.orgRole ?? ""] ?? [])],
  };
}

/**
 * Only a bearer token counts. Ignoring Clerk's cookie means a cross-site form or link can never
 * act as the reviewer; the web app sends `Authorization: Bearer <session token>` on every call.
 */
export function bearerReviewer(authenticate: Authenticate): ReviewerResolver {
  return async (req) => {
    if (!/^Bearer \S+$/.test(req.headers.authorization ?? "")) return null;
    const headers = new Headers({ authorization: req.headers.authorization ?? "" });
    const url = new URL(req.url, `${req.protocol}://${req.host}`);
    return reviewerFrom(await authenticate(new Request(url, { method: req.method, headers })));
  };
}

/** Clerk's networkless session-token check, configured from env. Undefined if Clerk isn't set up. */
export function clerkFromEnv(env = process.env): Authenticate | undefined {
  const secretKey = env.CLERK_SECRET_KEY;
  const publishableKey = env.CLERK_PUBLISHABLE_KEY;
  if (!secretKey || !publishableKey) return undefined;
  const authorizedParties = env.CLERK_AUTHORIZED_PARTIES?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const clerk = createClerkClient({ secretKey, publishableKey });

  return async (request) => {
    const state = await clerk.authenticateRequest(request, {
      acceptsToken: "session_token",
      ...(authorizedParties?.length ? { authorizedParties } : {}),
    });
    if (!state.isAuthenticated) return null;
    const auth = state.toAuth();
    return {
      userId: auth.userId,
      sessionId: auth.sessionId,
      orgId: auth.orgId ?? null,
      orgRole: auth.orgRole ?? null,
    };
  };
}

/** `GET /api/me`: who the server thinks is calling, so the UI shows verified roles, not guesses. */
export function registerMeRoute(app: FastifyInstance, reviewer: ReviewerResolver) {
  app.get("/api/me", async (req, reply) => {
    const me = await reviewer(req);
    if (!me) return reply.code(401).send({ error: "unauthenticated" });
    return { userId: me.userId, orgId: me.orgId, roles: me.roles };
  });
}
