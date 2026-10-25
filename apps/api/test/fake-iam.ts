import { decide, permissionsFor } from "@rehearsal/authz";
import { type AuthzDecision, type AuthzRequest, AuthzRuleFile } from "@rehearsal/contracts";
import raw from "../../../scenarios/authz/rehearsal-authz.v1.json" with { type: "json" };
import type {
  IamAnswer,
  IamClient,
  IdentityAnswer,
  MembershipAnswer,
  MembershipWrite,
} from "../src/iam";

const file = AuthzRuleFile.parse(raw);

/** A person the fake IAM will verify. Permissions come from the rule file, not from this object. */
export interface Caller {
  token: string;
  userId: string;
  orgId: string;
  clerkRole: string;
  sessionId: string;
}

export function caller(orgId: string, clerkRole: string, userId: string): Caller {
  return {
    token: `tok_${userId}_${orgId}`,
    userId,
    orgId,
    clerkRole,
    sessionId: `sess_${userId}`,
  };
}

export const finance = (orgId: string, userId = "user_fin") =>
  caller(orgId, "org:finance_lead", userId);
export const support = (orgId: string, userId = "user_sup") =>
  caller(orgId, "org:support_lead", userId);
export const member = (orgId: string, userId = "user_mem") => caller(orgId, "org:member", userId);
export const owner = (orgId: string, userId = "user_own") => caller(orgId, "org:owner", userId);

export function bearer(person: Caller): { authorization: string } {
  return { authorization: `Bearer ${person.token}` };
}

export interface FakeIam extends IamClient {
  requests: AuthzRequest[];
  /** Membership writes the route asked for after an allow. Empty when the route stopped first. */
  memberships: MembershipWrite[];
}

/**
 * IAM stand-in for route tests. It runs the real rule file, so a missing permission or a wrong
 * org is the engine's answer. `down` fails every call. `warp` rewrites the decision the route
 * sees. A role the rule file does not map is `invalid_role`, which is what IAM answers before
 * it would call Clerk.
 */
export function fakeIam(
  people: readonly Caller[],
  opts: {
    down?: boolean;
    now?: () => Date;
    warp?: (decision: AuthzDecision) => AuthzDecision;
    membership?: (command: MembershipWrite, person: Caller) => MembershipAnswer;
  } = {},
): FakeIam {
  const requests: AuthzRequest[] = [];
  const memberships: MembershipWrite[] = [];
  const byToken = new Map(people.map((person) => [person.token, person]));
  return {
    requests,
    memberships,
    async decide(request): Promise<IamAnswer> {
      requests.push(request);
      if (opts.down) return { kind: "unavailable" };
      if (request.mode.kind === "person") {
        const person = byToken.get(request.mode.token);
        if (!person) return answered(request, "deny", "unauthenticated", opts.warp);
        const result = decide({
          file,
          action: request.action,
          subject: { userId: person.userId, orgId: person.orgId, clerkRole: person.clerkRole },
          resource: request.resource,
          now: opts.now?.() ?? new Date(),
        });
        return answered(request, result.effect, result.reason, opts.warp);
      }
      const result = decide({
        file,
        action: request.action,
        subject: null,
        resource: request.resource,
        now: opts.now?.() ?? new Date(),
      });
      return answered(request, result.effect, result.reason, opts.warp);
    },
    async identify(token): Promise<IdentityAnswer> {
      if (opts.down) return { kind: "unavailable" };
      const person = byToken.get(token);
      if (!person) return { kind: "unauthenticated" };
      return {
        kind: "ok",
        person: {
          userId: person.userId,
          orgId: person.orgId,
          clerkRole: person.clerkRole,
          sessionId: person.sessionId,
          permissions: permissionsFor(file, person.clerkRole),
        },
      };
    },
    async membership(command): Promise<MembershipAnswer> {
      memberships.push(command);
      if (opts.down) return { kind: "unavailable" };
      const person = byToken.get(command.token);
      if (!person) return { kind: "result", result: { ok: false, error: "unauthenticated" } };
      if (opts.membership) return opts.membership(command, person);
      if (!Object.hasOwn(file.rolesFromClerk, command.role)) {
        return { kind: "result", result: { ok: false, error: "invalid_role" } };
      }
      if (command.kind === "invite") {
        return {
          kind: "result",
          result: {
            ok: true,
            kind: "invite",
            orgId: person.orgId,
            role: command.role,
            email: command.email,
          },
        };
      }
      return {
        kind: "result",
        result: {
          ok: true,
          kind: "set_role",
          orgId: person.orgId,
          role: command.role,
          userId: command.userId,
        },
      };
    },
  };
}

function answered(
  request: AuthzRequest,
  effect: "allow" | "deny",
  reason: string,
  warp?: (decision: AuthzDecision) => AuthzDecision,
): IamAnswer {
  const decision: AuthzDecision = {
    effect,
    action: request.action,
    rule: request.rule,
    resource: request.resource,
    reason,
  };
  return { kind: "decision", decision: warp ? warp(decision) : decision };
}
