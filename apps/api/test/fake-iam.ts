import { decide, permissionsFor } from "@rehearsal/authz";
import { type AuthzDecision, type AuthzRequest, AuthzRuleFile } from "@rehearsal/contracts";
import raw from "../../../scenarios/authz/rehearsal-authz.v1.json" with { type: "json" };
import type { IamAnswer, IamClient, IdentityAnswer } from "../src/iam";

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
}

/**
 * IAM stand-in for route tests. It runs the real rule file, so a missing permission or a wrong
 * org is the engine's answer. `down` fails both calls. `warp` rewrites the decision the route sees.
 */
export function fakeIam(
  people: readonly Caller[],
  opts: {
    down?: boolean;
    now?: () => Date;
    warp?: (decision: AuthzDecision) => AuthzDecision;
  } = {},
): FakeIam {
  const requests: AuthzRequest[] = [];
  const byToken = new Map(people.map((person) => [person.token, person]));
  return {
    requests,
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
