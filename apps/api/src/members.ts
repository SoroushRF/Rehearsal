import type { MembershipResult } from "@rehearsal/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  authorizeCollection,
  bearerToken,
  type IamClient,
  type MembershipWrite,
  refuse,
} from "./iam";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const InviteBody = z.strictObject({
  email: z.string().trim().regex(EMAIL),
  role: z.string().trim().min(1),
});

const RoleBody = z.strictObject({
  role: z.string().trim().min(1),
});

/**
 * Invites and role changes have no stored row. The organization is the one IAM verified from
 * the token, never a value from the body or the URL. After that allow, IAM verifies the token
 * again and is the only process that calls Clerk.
 */
export function registerMemberRoutes(app: FastifyInstance, iam?: IamClient) {
  app.post("/api/members/invitations", async (req, reply) => {
    const token = bearerToken(req);
    const gate = await authorizeCollection(iam, token, "POST /api/members/invitations");
    if (!gate.ok) return refuse(reply, gate, "not_found");
    if (!token) return reply.code(401).send({ error: "unauthenticated" });
    const body = InviteBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    return perform(reply, iam, gate.person.orgId, {
      kind: "invite",
      token,
      email: body.data.email,
      role: body.data.role,
    });
  });

  app.patch<{ Params: { userId: string } }>("/api/members/:userId/role", async (req, reply) => {
    const token = bearerToken(req);
    const gate = await authorizeCollection(iam, token, "PATCH /api/members/:userId/role");
    if (!gate.ok) return refuse(reply, gate, "not_found");
    if (!token) return reply.code(401).send({ error: "unauthenticated" });
    const body = RoleBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const userId = req.params.userId.trim();
    if (!userId) return reply.code(400).send({ error: "invalid_request" });
    return perform(reply, iam, gate.person.orgId, {
      kind: "set_role",
      token,
      userId,
      role: body.data.role,
    });
  });
}

async function perform(
  reply: FastifyReply,
  iam: IamClient | undefined,
  orgId: string,
  command: MembershipWrite,
) {
  if (!iam) return reply.code(503).send({ error: "iam_unavailable" });
  const answer = await iam.membership(command);
  if (answer.kind !== "result") return reply.code(503).send({ error: "iam_unavailable" });
  const result = answer.result;
  if (!result.ok) return reply.code(statusFor(result.error)).send({ error: bodyFor(result.error) });
  if (!matches(command, result, orgId)) return reply.code(503).send({ error: "iam_unavailable" });
  if (result.kind === "invite") {
    return reply.code(201).send({ email: result.email, role: result.role });
  }
  return reply.code(200).send({ userId: result.userId, role: result.role });
}

/** A success is about this command and the organization the gate already verified. */
function matches(command: MembershipWrite, result: MembershipResult, orgId: string): boolean {
  if (!result.ok || result.role !== command.role || result.orgId !== orgId) return false;
  if (command.kind === "invite") return result.kind === "invite" && result.email === command.email;
  return result.kind === "set_role" && result.userId === command.userId;
}

function statusFor(error: Extract<MembershipResult, { ok: false }>["error"]): number {
  switch (error) {
    case "unauthenticated":
    case "no_active_organization":
      return 401;
    case "forbidden":
      return 403;
    case "invalid_role":
    case "bad_request":
      return 400;
    case "last_owner":
      return 409;
    case "member_not_found":
      return 404;
    default:
      return 503;
  }
}

function bodyFor(error: Extract<MembershipResult, { ok: false }>["error"]): string {
  switch (error) {
    case "unauthenticated":
    case "no_active_organization":
      return "unauthenticated";
    case "forbidden":
      return "forbidden";
    case "invalid_role":
      return "invalid_role";
    case "bad_request":
      return "invalid_request";
    case "last_owner":
      return "last_owner";
    case "member_not_found":
      return "member_not_found";
    default:
      return "iam_unavailable";
  }
}
