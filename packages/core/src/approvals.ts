import type { ApprovalGrant, PermissionV1, PlanManifest, Role } from "@rehearsal/contracts";
import { type BillingPolicy, evaluateBillingPolicy } from "./policy";

/** The two seats a plan with dual approval needs filled, by two different people. */
export const DUAL_SEATS = [
  "rehearsal:approve:support_step",
  "rehearsal:approve:finance_step",
] as const satisfies readonly PermissionV1[];

export interface ApprovalStatus {
  /** Policy asks for two distinct approvers on this plan. */
  dualRequired: boolean;
  /** Always true when `dualRequired` is false: nothing beyond the ordinary grant is asked. */
  satisfied: boolean;
  /** Who fills which seat right now, from live grants only. A seat is a stored permission. */
  signed: { permission: PermissionV1; grantId: string; actorUserId: string }[];
  /** Seat permissions still open. A seat held by the same person as the other counts as open. */
  needed: PermissionV1[];
}

/** Whether any policy the plan cites asks for two approvers. Unknown policies are ignored here. */
export function requiresDualApproval(
  manifest: PlanManifest,
  policies: readonly BillingPolicy[],
): boolean {
  return manifest.policies.some((ref) => {
    const policy = policies.find((p) => p.id === ref.id && p.version === ref.version);
    return policy ? evaluateBillingPolicy(manifest, policy).dualApproval.length > 0 : false;
  });
}

/** Live now, and for exactly this plan: not revoked, already granted, not expired. */
export function liveGrantsFor(
  grants: readonly ApprovalGrant[],
  plan: { orgId: string; planId: string; revision: number; planHash: string },
  at: Date,
): ApprovalGrant[] {
  const now = at.getTime();
  return grants.filter(
    (g) =>
      g.orgId === plan.orgId &&
      g.planId === plan.planId &&
      g.revision === plan.revision &&
      g.planHash === plan.planHash &&
      g.revokedAt === null &&
      Date.parse(g.grantedAt) <= now &&
      Date.parse(g.expiresAt) > now,
  );
}

/** Seat permissions stored on the grant. Roles are not consulted and are not mapped. */
function heldSeats(grant: ApprovalGrant): PermissionV1[] {
  const permissions = grant.permissions ?? [];
  return DUAL_SEATS.filter((seat) => permissions.includes(seat));
}

/**
 * Fills the two seats from permissions stored on live grants. A grant fills a seat only if it
 * holds that permission, and the two seats need different users: one person who holds both fills
 * one. A grant with roles and no permissions fills none. When several pairs work, grants holding
 * fewer of these seats are used first and then the older one, so the answer is stable.
 * Pass grants already filtered with `liveGrantsFor`.
 */
export function dualApprovalStatus(live: readonly ApprovalGrant[]): ApprovalStatus {
  const [supportSeat, financeSeat] = DUAL_SEATS;
  const order = (a: ApprovalGrant, b: ApprovalGrant) =>
    heldSeats(a).length - heldSeats(b).length ||
    Date.parse(a.grantedAt) - Date.parse(b.grantedAt) ||
    a.id.localeCompare(b.id);
  const holding = (seat: PermissionV1) =>
    live.filter((g) => heldSeats(g).includes(seat)).sort(order);
  const support = holding(supportSeat);
  const finance = holding(financeSeat);
  const seat = (permission: PermissionV1, g: ApprovalGrant) => ({
    permission,
    grantId: g.id,
    actorUserId: g.actorUserId,
  });

  for (const s of support) {
    const f = finance.find((g) => g.actorUserId !== s.actorUserId);
    if (f) {
      return {
        dualRequired: true,
        satisfied: true,
        signed: [seat(supportSeat, s), seat(financeSeat, f)],
        needed: [],
      };
    }
  }
  // Not satisfied. Show the scarcer seat first when one person could fill either.
  const f0 = finance[0];
  if (f0) {
    return {
      dualRequired: true,
      satisfied: false,
      signed: [seat(financeSeat, f0)],
      needed: [supportSeat],
    };
  }
  const s0 = support[0];
  return {
    dualRequired: true,
    satisfied: false,
    signed: s0 ? [seat(supportSeat, s0)] : [],
    needed: s0 ? [financeSeat] : [supportSeat, financeSeat],
  };
}

/** One call for the API and admission: is a second approver asked for, and is the plan covered. */
export function approvalStatus(
  manifest: PlanManifest,
  planHash: string,
  policies: readonly BillingPolicy[],
  grants: readonly ApprovalGrant[],
  at: Date,
): ApprovalStatus {
  if (!requiresDualApproval(manifest, policies)) {
    return { dualRequired: false, satisfied: true, signed: [], needed: [] };
  }
  return dualApprovalStatus(liveGrantsFor(grants, { ...manifest, planHash }, at));
}

/** A sentence for a refusal: which permissions are missing. */
export function explainShortfall(status: ApprovalStatus): string {
  const [supportSeat, financeSeat] = DUAL_SEATS;
  const open = status.needed.join(" + ");
  const who = status.signed.map((s) => `${s.actorUserId} as ${s.permission}`).join(", ");
  return `needs two different approvers (${supportSeat} + ${financeSeat}); ${
    who ? `signed: ${who}; ` : ""
  }still needed: ${open}`;
}

/**
 * A plan step's seat, as the permission `run:admit` expects. This reads the plan, not a grant:
 * a grant's `roles` are never turned into permissions.
 */
const ROLE_PERMISSION = {
  support_lead: "rehearsal:approve:support_step",
  finance_lead: "rehearsal:approve:finance_step",
} as const satisfies Record<Role, PermissionV1>;

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
