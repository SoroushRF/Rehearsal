import { existsSync, readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import {
  type ApprovalGrant,
  type AuthzDecision,
  AuthzDecision as AuthzDecisionSchema,
  type AuthzRequest,
  IdentityResult as IdentityResultSchema,
  type MembershipResult,
  MembershipResult as MembershipResultSchema,
  type PermissionV1,
  type PlanManifest,
  type Role,
} from "@rehearsal/contracts";
import { type BillingPolicy, evaluateBillingPolicy, requiresDualApproval } from "@rehearsal/core";
import type { FastifyReply, FastifyRequest } from "fastify";

/** The rule file this API asks IAM to load. The caller names it; IAM has the text. */
export const AUTHZ_RULE = { id: "rehearsal-authz", version: 1 } as const;

const ORG_MISMATCH = "subject.orgId != resource.orgId";
const TIMEOUT_MS = 3_000;

/** A person IAM verified. The API does not learn this from Clerk. */
export interface Person {
  userId: string;
  orgId: string;
  clerkRole: string | null;
  permissions: readonly PermissionV1[];
  sessionId: string;
}

export type IamAnswer = { kind: "decision"; decision: AuthzDecision } | { kind: "unavailable" };

export type IdentityAnswer =
  | { kind: "ok"; person: Person }
  | { kind: "unauthenticated" }
  | { kind: "unavailable" };

/** A Clerk write the route asks IAM to perform. The organization is not included. */
export type MembershipWrite =
  | { kind: "invite"; token: string; email: string; role: string }
  | { kind: "set_role"; token: string; userId: string; role: string };

export type MembershipAnswer =
  | { kind: "result"; result: MembershipResult }
  | { kind: "unavailable" };

/**
 * The only way a route talks to IAM. Production uses mTLS (`createIamClient`); tests pass a fake.
 * A missing, timed-out, malformed, or mismatched answer is `unavailable` — the caller writes nothing.
 */
export interface IamClient {
  decide(request: AuthzRequest): Promise<IamAnswer>;
  identify(token: string): Promise<IdentityAnswer>;
  /** Asks IAM to call Clerk. IAM verifies `token` again and writes only in that organization. */
  membership(command: MembershipWrite): Promise<MembershipAnswer>;
}

export type Gate =
  | { ok: true; person: Person }
  | { ok: false; status: 401 | 403 | 404 | 503; error: string };

/** Only a bearer token counts. A cookie is not a session. */
export function bearerToken(req: FastifyRequest): string | null {
  const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "");
  return match?.[1] ?? null;
}

function fail(status: 401 | 403 | 404 | 503, error: string): Gate {
  return { ok: false, status, error };
}

/** Send a refusal. Wrong org uses the route's own not-found code so it matches a missing row. */
export function refuse(reply: FastifyReply, gate: Extract<Gate, { ok: false }>, notFound: string) {
  const error = gate.status === 404 ? notFound : gate.error;
  return reply.code(gate.status).send({ error });
}

/**
 * One person-facing question. `resource` is facts from a stored row. The verified org is compared
 * with that row: a mismatch is 404 even when the engine also reports a missing permission, so a
 * foreign row is indistinguishable from a missing one. Any other well-formed deny is 403.
 */
export async function authorize(
  iam: IamClient | undefined,
  token: string | null,
  action: string,
  resource: Record<string, unknown>,
): Promise<Gate> {
  if (!token) return fail(401, "unauthenticated");
  if (!iam) return fail(503, "iam_unavailable");
  const identified = await iam.identify(token);
  if (identified.kind === "unavailable") return fail(503, "iam_unavailable");
  if (identified.kind !== "ok") return fail(401, "unauthenticated");

  const request: AuthzRequest = {
    action,
    rule: AUTHZ_RULE,
    mode: { kind: "person", token },
    resource,
  };
  const answer = await iam.decide(request);
  if (answer.kind !== "decision" || !echoes(request, answer.decision)) {
    return fail(503, "iam_unavailable");
  }
  const decision = answer.decision;
  const storedOrg = resource.orgId;
  const wrongOrg =
    decision.reason.includes(ORG_MISMATCH) ||
    (typeof storedOrg === "string" && storedOrg !== identified.person.orgId);
  if (wrongOrg) return fail(404, "not_found");
  if (decision.effect !== "allow") {
    if (
      decision.reason === "unauthenticated" ||
      decision.reason.includes("no active organization")
    ) {
      return fail(401, "unauthenticated");
    }
    return fail(403, "forbidden");
  }
  return { ok: true, person: identified.person };
}

/**
 * A list has no stored row. The org is the one IAM verified from the token, never a value from
 * the URL or the body. The permission check is the gate; the org comparison then matches by
 * construction because the list is that org's rows.
 */
export async function authorizeCollection(
  iam: IamClient | undefined,
  token: string | null,
  action: string,
): Promise<Gate> {
  if (!token) return fail(401, "unauthenticated");
  if (!iam) return fail(503, "iam_unavailable");
  const identified = await iam.identify(token);
  if (identified.kind === "unavailable") return fail(503, "iam_unavailable");
  if (identified.kind !== "ok") return fail(401, "unauthenticated");
  return authorize(iam, token, action, { orgId: identified.person.orgId });
}

/** Verifies the token and stops. Used when the row is missing, so a bad token stays 401. */
export async function requirePerson(
  iam: IamClient | undefined,
  token: string | null,
): Promise<Gate> {
  if (!token) return fail(401, "unauthenticated");
  if (!iam) return fail(503, "iam_unavailable");
  const identified = await iam.identify(token);
  if (identified.kind === "unavailable") return fail(503, "iam_unavailable");
  if (identified.kind !== "ok") return fail(401, "unauthenticated");
  return { ok: true, person: identified.person };
}

/** `run:admit` has no person. A well-formed deny does not queue. */
export async function authorizeGrants(
  iam: IamClient | undefined,
  resource: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; status: 403 | 503; error: string }> {
  if (!iam) return { ok: false, status: 503, error: "iam_unavailable" };
  const request: AuthzRequest = {
    action: "run:admit",
    rule: AUTHZ_RULE,
    mode: { kind: "grants" },
    resource,
  };
  const answer = await iam.decide(request);
  if (answer.kind !== "decision" || !echoes(request, answer.decision)) {
    return { ok: false, status: 503, error: "iam_unavailable" };
  }
  if (answer.decision.effect !== "allow") return { ok: false, status: 403, error: "forbidden" };
  return { ok: true };
}

/** The seats a plan's actions name, and whether policy asks for two approvers. No amounts. */
export function approvalFacts(
  manifest: PlanManifest,
  policies: readonly BillingPolicy[],
): { requiredPermissions: PermissionV1[]; dualRequired: boolean } {
  const required = new Set<PermissionV1>();
  for (const action of manifest.actions) required.add(ROLE_PERMISSION[action.requiredRole]);
  for (const ref of manifest.policies) {
    const policy = policies.find((p) => p.id === ref.id && p.version === ref.version);
    if (!policy) continue;
    for (const role of evaluateBillingPolicy(manifest, policy).requiredRoles) {
      required.add(ROLE_PERMISSION[role]);
    }
  }
  return {
    requiredPermissions: [...required].sort(),
    dualRequired: requiresDualApproval(manifest, policies),
  };
}

/**
 * Facts IAM's `run:admit` rules read. Permissions are copied only when the row has them.
 * `roles` are not turned into permissions: a role-only grant does not cover the list.
 */
export function grantFact(grant: ApprovalGrant): Record<string, unknown> {
  return {
    orgId: grant.orgId,
    planHash: grant.planHash,
    revision: grant.revision,
    revokedAt: grant.revokedAt,
    grantedAt: grant.grantedAt,
    expiresAt: grant.expiresAt,
    actorUserId: grant.actorUserId,
    ...(grant.permissions ? { permissions: grant.permissions } : {}),
  };
}

const ROLE_PERMISSION = {
  support_lead: "rehearsal:approve:support_step",
  finance_lead: "rehearsal:approve:finance_step",
} as const satisfies Record<Role, PermissionV1>;

/**
 * The legacy `roles` column is still required, and the executor still reads it (T4.22 replaces
 * that check). These are the approve permissions IAM already allowed for this person, not a
 * second authorization decision.
 */
export function rolesFromPermissions(permissions: readonly string[]): Role[] {
  const roles: Role[] = [];
  if (permissions.includes(ROLE_PERMISSION.finance_lead)) roles.push("finance_lead");
  if (permissions.includes(ROLE_PERMISSION.support_lead)) roles.push("support_lead");
  return roles;
}

/** True when the decision is about the action and the facts we sent, including nested keys. */
export function echoes(request: AuthzRequest, decision: AuthzDecision): boolean {
  return (
    decision.action === request.action &&
    decision.rule.id === request.rule.id &&
    decision.rule.version === request.rule.version &&
    canonical(decision.resource) === canonical(request.resource)
  );
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export interface IamClientOptions {
  url: string;
  cert: string | Buffer;
  key: string | Buffer;
  ca: string | Buffer;
  timeoutMs?: number;
}

/**
 * mTLS to IAM. `ca` is the trust store for IAM's server certificate (`rejectUnauthorized`),
 * and `cert`/`key` are this API's client certificate. A transport failure is unavailable.
 */
export function createIamClient(options: IamClientOptions): IamClient {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const post = (path: string, body: unknown) =>
    postJson(options.url, path, body, options, timeoutMs);

  return {
    async decide(request) {
      try {
        const parsed = AuthzDecisionSchema.safeParse(await post("/v1/decide", request));
        if (!parsed.success || !echoes(request, parsed.data)) return { kind: "unavailable" };
        return { kind: "decision", decision: parsed.data };
      } catch {
        return { kind: "unavailable" };
      }
    },
    async identify(token) {
      try {
        const parsed = IdentityResultSchema.safeParse(
          await post("/v1/identity", { token, rule: AUTHZ_RULE }),
        );
        if (!parsed.success) return { kind: "unavailable" };
        if (!parsed.data.ok) {
          return parsed.data.error === "unknown_rule"
            ? { kind: "unavailable" }
            : { kind: "unauthenticated" };
        }
        return {
          kind: "ok",
          person: {
            userId: parsed.data.userId,
            orgId: parsed.data.orgId,
            clerkRole: parsed.data.clerkRole,
            permissions: parsed.data.permissions,
            sessionId: parsed.data.sessionId,
          },
        };
      } catch {
        return { kind: "unavailable" };
      }
    },
    async membership(command) {
      try {
        const parsed = MembershipResultSchema.safeParse(
          await post("/v1/members", { ...command, rule: AUTHZ_RULE }),
        );
        if (!parsed.success) return { kind: "unavailable" };
        return { kind: "result", result: parsed.data };
      } catch {
        return { kind: "unavailable" };
      }
    },
  };
}

/** Undefined unless the certificate files and `IAM_URL` are all set. The process then cannot ask. */
export function iamClientFromEnv(env: NodeJS.ProcessEnv = process.env): IamClient | undefined {
  const cert = env.IAM_CLIENT_CERT;
  const key = env.IAM_CLIENT_KEY;
  const ca = env.IAM_CLIENT_CA;
  const url = env.IAM_URL;
  if (!cert || !key || !ca || !url) return undefined;
  if (!existsSync(cert) || !existsSync(key) || !existsSync(ca)) return undefined;
  return createIamClient({
    url,
    cert: readFileSync(cert),
    key: readFileSync(key),
    ca: readFileSync(ca),
  });
}

function postJson(
  base: string,
  path: string,
  body: unknown,
  tls: { cert: string | Buffer; key: string | Buffer; ca: string | Buffer },
  timeoutMs: number,
): Promise<unknown> {
  const url = new URL(path, base);
  const payload = JSON.stringify(body);
  // Node refuses an IP address as the TLS server name. An IP URL is still checked against the
  // certificate's IP name; a hostname is sent as the server name and checked the same way.
  const servername = isIP(url.hostname) ? undefined : url.hostname;
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        ...(servername ? { servername } : {}),
        method: "POST",
        path: `${url.pathname}${url.search}`,
        ca: tls.ca,
        cert: tls.cert,
        key: tls.key,
        rejectUnauthorized: true,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(payload);
  });
}
