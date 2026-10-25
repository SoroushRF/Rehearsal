import type { ApprovalGrant, PermissionV1, Role } from "@rehearsal/contracts";
import { describe, expect, it } from "vitest";
import {
  approvalStatus,
  type BillingPolicy,
  dualApprovalStatus,
  evaluateBillingPolicy,
  explainShortfall,
  liveGrantsFor,
  requiresDualApproval,
} from "../src";
import { manifest, refund } from "./fixture";

const HASH = "a".repeat(64);
const AT = new Date("2026-10-24T12:00:00.000Z");
const V1: BillingPolicy = {
  id: "billing-remedy",
  version: 1,
  currency: "cad",
  financeThresholdMinor: 10_000,
};
const V3: BillingPolicy = {
  id: "billing-remedy",
  version: 3,
  currency: "cad",
  financeThresholdMinor: 10_000,
  creditMaxMinor: 10_000,
  dualApprovalMinor: 10_000,
};

const SUPPORT = "rehearsal:approve:support_step";
const FINANCE = "rehearsal:approve:finance_step";

const grant = (
  id: string,
  user: string,
  permissions: readonly PermissionV1[] | undefined,
  over: Partial<ApprovalGrant> = {},
) =>
  ({
    id,
    orgId: "org_1",
    planId: "plan_1",
    revision: 1,
    planHash: HASH,
    actorUserId: user,
    actorSessionId: `sess_${user}`,
    roles: ["support_lead"] satisfies Role[],
    ...(permissions ? { permissions: [...permissions] } : {}),
    grantedAt: "2026-10-24T11:00:00.000Z",
    expiresAt: "2026-10-24T13:00:00.000Z",
    revokedAt: null,
    ...over,
  }) satisfies ApprovalGrant;

const big = (over: object = {}) =>
  ({
    ...refund,
    requiredRole: "finance_lead",
    args: { ...refund.args, amount: { amountMinor: 12_500, currency: "cad" } },
    ...over,
  }) as typeof refund;

describe("policy v3 names the steps that need two approvers", () => {
  it("flags a refund at or above the line, and only under v3", () => {
    const atLine = {
      ...big(),
      args: { ...big().args, amount: { amountMinor: 10_000, currency: "cad" } },
    };
    const below = {
      ...big(),
      args: { ...big().args, amount: { amountMinor: 9_999, currency: "cad" } },
    };
    expect(evaluateBillingPolicy(manifest([big()]), V3).dualApproval).toEqual([refund.id]);
    expect(evaluateBillingPolicy(manifest([atLine as typeof refund]), V3).dualApproval).toEqual([
      refund.id,
    ]);
    expect(evaluateBillingPolicy(manifest([below as typeof refund]), V3).dualApproval).toEqual([]);
    expect(evaluateBillingPolicy(manifest([big()]), V1).dualApproval).toEqual([]);
  });

  it("is asked for only by a plan that cites a policy that asks", () => {
    const plan = manifest([big()]);
    expect(
      requiresDualApproval({ ...plan, policies: [{ id: "billing-remedy", version: 3 }] }, [V1, V3]),
    ).toBe(true);
    expect(
      requiresDualApproval({ ...plan, policies: [{ id: "billing-remedy", version: 1 }] }, [V1, V3]),
    ).toBe(false);
    // A policy that isn't loaded can't ask; admission refuses an unknown policy separately.
    expect(
      requiresDualApproval({ ...plan, policies: [{ id: "billing-remedy", version: 3 }] }, [V1]),
    ).toBe(false);
  });
});

describe("dualApprovalStatus", () => {
  it("is satisfied by a support permission and a different person's finance permission", () => {
    const s = dualApprovalStatus([grant("g1", "sup", [SUPPORT]), grant("g2", "fin", [FINANCE])]);
    expect(s).toMatchObject({ satisfied: true, needed: [] });
    expect(s.signed.map((x) => [x.permission, x.actorUserId])).toEqual([
      [SUPPORT, "sup"],
      [FINANCE, "fin"],
    ]);
  });

  it("is satisfied when one person holds both permissions but another fills a seat", () => {
    const s = dualApprovalStatus([
      grant("g1", "boss", [SUPPORT, FINANCE]),
      grant("g2", "sup", [SUPPORT]),
    ]);
    expect(s.satisfied).toBe(true);
    expect(s.signed.map((x) => [x.permission, x.actorUserId])).toEqual([
      [SUPPORT, "sup"],
      [FINANCE, "boss"],
    ]);
  });

  it("is not satisfied by one person holding both permissions, however many times they sign", () => {
    const s = dualApprovalStatus([
      grant("g1", "boss", [SUPPORT, FINANCE]),
      grant("g2", "boss", [SUPPORT, FINANCE], { actorSessionId: "other" }),
    ]);
    expect(s).toMatchObject({ satisfied: false, needed: [SUPPORT] });
    expect(s.signed).toEqual([{ permission: FINANCE, grantId: "g1", actorUserId: "boss" }]);
  });

  it("names the open permission for a lone approver, and both for none", () => {
    expect(dualApprovalStatus([grant("g1", "sup", [SUPPORT])]).needed).toEqual([FINANCE]);
    expect(dualApprovalStatus([grant("g1", "fin", [FINANCE])]).needed).toEqual([SUPPORT]);
    expect(dualApprovalStatus([])).toMatchObject({
      satisfied: false,
      needed: [SUPPORT, FINANCE],
      signed: [],
    });
  });

  it("does not map roles into permissions, and a role-only grant fills no seat", () => {
    const bothRoles = ["support_lead", "finance_lead"] satisfies Role[];
    const rolesAndOnePermission = dualApprovalStatus([
      grant("g1", "boss", [SUPPORT], { roles: bothRoles }),
    ]);
    expect(rolesAndOnePermission.signed).toEqual([
      { permission: SUPPORT, grantId: "g1", actorUserId: "boss" },
    ]);
    expect(rolesAndOnePermission.needed).toEqual([FINANCE]);

    const roleOnly = grant("g1", "boss", undefined, { roles: bothRoles });
    expect(roleOnly.permissions).toBeUndefined();
    expect(dualApprovalStatus([roleOnly])).toMatchObject({
      satisfied: false,
      signed: [],
      needed: [SUPPORT, FINANCE],
    });
    const withFinance = dualApprovalStatus([roleOnly, grant("g2", "fin", [FINANCE])]);
    expect(withFinance.satisfied).toBe(false);
    expect(withFinance.signed.map((x) => x.actorUserId)).toEqual(["fin"]);
    expect(withFinance.needed).toEqual([SUPPORT]);
  });

  it("names the missing permissions", () => {
    expect(explainShortfall(dualApprovalStatus([grant("g1", "fin", [FINANCE])]))).toBe(
      `needs two different approvers (${SUPPORT} + ${FINANCE}); signed: fin as ${FINANCE}; still needed: ${SUPPORT}`,
    );
    expect(explainShortfall(dualApprovalStatus([]))).toBe(
      `needs two different approvers (${SUPPORT} + ${FINANCE}); still needed: ${SUPPORT} + ${FINANCE}`,
    );
  });
});

describe("liveGrantsFor and approvalStatus", () => {
  const plan = { orgId: "org_1", planId: "plan_1", revision: 1, planHash: HASH };
  const sup = grant("g1", "sup", [SUPPORT]);
  const fin = grant("g2", "fin", [FINANCE]);

  it.each<[string, Partial<ApprovalGrant>]>([
    ["revoked", { revokedAt: "2026-10-24T11:30:00.000Z" }],
    ["expired", { expiresAt: "2026-10-24T12:00:00.000Z" }],
    ["not yet granted", { grantedAt: "2026-10-24T12:00:01.000Z" }],
    ["for another hash", { planHash: "b".repeat(64) }],
    ["for another revision", { revision: 2 }],
    ["for another plan", { planId: "plan_2" }],
    ["for another org", { orgId: "org_2" }],
  ])("drops a grant that is %s", (_label, over) => {
    expect(liveGrantsFor([{ ...sup, ...over }, fin], plan, AT).map((g) => g.id)).toEqual(["g2"]);
  });

  it("asks nothing extra of a plan that policy doesn't flag", () => {
    const status = approvalStatus(
      { ...manifest([big()]), policies: [{ id: "billing-remedy", version: 1 }] },
      HASH,
      [V1, V3],
      [],
      AT,
    );
    expect(status).toEqual({ dualRequired: false, satisfied: true, signed: [], needed: [] });
  });

  it("reports who is still needed for a flagged plan", () => {
    const flagged = {
      ...manifest([big()]),
      orgId: "org_1",
      planId: "plan_1",
      policies: [{ id: "billing-remedy", version: 3 }],
    };
    const status = approvalStatus(flagged, HASH, [V1, V3], [fin], AT);
    expect(status).toMatchObject({
      dualRequired: true,
      satisfied: false,
      needed: [SUPPORT],
    });
    expect(approvalStatus(flagged, HASH, [V1, V3], [fin, sup], AT).satisfied).toBe(true);
  });
});
