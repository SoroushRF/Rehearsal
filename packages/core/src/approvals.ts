import type { ApprovalGrant, PlanManifest, Role } from "@rehearsal/contracts";
import { type BillingPolicy, evaluateBillingPolicy } from "./policy";

/** The two seats a plan with dual approval needs filled, by two different people. */
export const DUAL_SEATS = ["support_lead", "finance_lead"] as const satisfies readonly Role[];

export interface ApprovalStatus {
  /** Policy asks for two distinct approvers on this plan. */
  dualRequired: boolean;
  /** Always true when `dualRequired` is false: nothing beyond the ordinary grant is asked. */
  satisfied: boolean;
  /** Who fills which seat right now, from live grants only. */
  signed: { role: Role; grantId: string; actorUserId: string }[];
  /** Seats still open. A seat held by the same person as the other seat counts as open. */
  needed: Role[];
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

/**
 * Fills the two seats from live grants. A grant fills a seat only if it holds that role, and the
 * two seats need different users: one person with both roles fills one. When several pairs work,
 * grants holding fewer roles are used first and then the older one, so the answer is stable.
 * Pass grants already filtered with `liveGrantsFor`.
 */
export function dualApprovalStatus(live: readonly ApprovalGrant[]): ApprovalStatus {
  const order = (a: ApprovalGrant, b: ApprovalGrant) =>
    a.roles.length - b.roles.length ||
    Date.parse(a.grantedAt) - Date.parse(b.grantedAt) ||
    a.id.localeCompare(b.id);
  const holding = (role: Role) => live.filter((g) => g.roles.includes(role)).sort(order);
  const support = holding("support_lead");
  const finance = holding("finance_lead");
  const seat = (role: Role, g: ApprovalGrant) => ({
    role,
    grantId: g.id,
    actorUserId: g.actorUserId,
  });

  for (const s of support) {
    const f = finance.find((g) => g.actorUserId !== s.actorUserId);
    if (f) {
      return {
        dualRequired: true,
        satisfied: true,
        signed: [seat("support_lead", s), seat("finance_lead", f)],
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
      signed: [seat("finance_lead", f0)],
      needed: ["support_lead"],
    };
  }
  const s0 = support[0];
  return {
    dualRequired: true,
    satisfied: false,
    signed: s0 ? [seat("support_lead", s0)] : [],
    needed: s0 ? ["finance_lead"] : ["support_lead", "finance_lead"],
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

/** A sentence for a refusal: who is missing. */
export function explainShortfall(status: ApprovalStatus): string {
  const open = status.needed.join(" + ");
  const who = status.signed.map((s) => `${s.actorUserId} as ${s.role}`).join(", ");
  return `needs two different approvers (support_lead + finance_lead); ${
    who ? `signed: ${who}; ` : ""
  }still needed: ${open}`;
}
