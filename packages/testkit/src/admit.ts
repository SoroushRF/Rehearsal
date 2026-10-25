import type {
  ApprovalGrant,
  AuthzDecision,
  AuthzRequest,
  PermissionV1,
} from "@rehearsal/contracts";
import { AuthzRuleFile } from "@rehearsal/contracts";
import type { RunAdmit } from "@rehearsal/core";
import raw from "../../../scenarios/authz/rehearsal-authz.v1.json" with { type: "json" };
import { decide } from "../../authz/src/decide";

const file = AuthzRuleFile.parse(raw);

/** The two approval seats, stored on a grant the way an approval writes permissions. */
export const APPROVAL_PERMISSIONS = [
  "rehearsal:approve:support_step",
  "rehearsal:approve:finance_step",
] as const satisfies readonly PermissionV1[];

export const AUTHZ_RULE = { id: "rehearsal-authz", version: 1 } as const;

/**
 * A grant written the way T4.21 stores one: permissions and the rule version, alongside roles.
 * Permissions are not derived from `roles`. Omitting `permissions` fills both seats. Passing
 * `permissions: undefined` leaves a role-only grant, which `run:admit` denies.
 */
export function approvedGrant(grant: ApprovalGrant): ApprovalGrant {
  const hasPermissions = Object.hasOwn(grant, "permissions");
  return {
    ...(hasPermissions ? {} : { permissions: [...APPROVAL_PERMISSIONS] }),
    authzRule: AUTHZ_RULE,
    ...grant,
  };
}

export interface FakeRunAdmit extends RunAdmit {
  requests: AuthzRequest[];
}

/**
 * IAM stand-in for executor tests. It runs the real rule file. `down` fails every call.
 * `warp` rewrites the decision the executor sees, so a mismatched echo can be refused.
 * `now` must be the executor's clock: grant timestamps are compared to it.
 */
export function fakeRunAdmit(
  opts: {
    down?: boolean;
    now?: () => Date;
    warp?: (decision: AuthzDecision) => AuthzDecision;
  } = {},
): FakeRunAdmit {
  const requests: AuthzRequest[] = [];
  return {
    requests,
    async decide(request) {
      requests.push(request);
      if (opts.down || request.mode.kind !== "grants") return { kind: "unavailable" };
      const result = decide({
        file,
        action: request.action,
        subject: null,
        resource: request.resource,
        now: opts.now?.() ?? new Date(),
      });
      const decision: AuthzDecision = {
        effect: result.effect,
        action: request.action,
        rule: request.rule,
        resource: request.resource,
        reason: result.reason,
      };
      return { kind: "decision", decision: opts.warp ? opts.warp(decision) : decision };
    },
  };
}
