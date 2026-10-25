import { describe, expect, it } from "vitest";
import {
  ApprovalGrant,
  AuthzCheck,
  AuthzDecision,
  AuthzRequest,
  AuthzRule,
  AuthzRuleFile,
  PERMISSIONS_V1,
  Permission,
  PermissionV1,
} from "../src";

const HASH = "a".repeat(64);

const ruleFile = {
  id: "rehearsal-authz",
  version: 1,
  rolesFromClerk: { "org:member": "member" },
  roles: {
    owner: ["rehearsal:read:plan"],
    finance_lead: ["rehearsal:read:plan"],
    support_lead: ["rehearsal:read:plan"],
    member: ["rehearsal:read:plan"],
  },
  rules: [
    {
      action: "GET /api/plans",
      rbac: { anyOf: ["rehearsal:read:plan"] },
      abac: [{ eq: ["subject.orgId", "resource.orgId"] }],
    },
  ],
};

const request = {
  action: "GET /api/plans",
  rule: { id: "rehearsal-authz", version: 1 },
  resource: { orgId: "org_1" },
};

const grant = {
  id: "grant_1",
  orgId: "org_1",
  planId: "plan_1",
  revision: 1,
  planHash: HASH,
  actorUserId: "user_1",
  actorSessionId: "sess_1",
  roles: ["support_lead"],
  grantedAt: "2026-10-24T11:00:00.000Z",
  expiresAt: "2026-10-24T13:00:00.000Z",
  revokedAt: null,
};

describe("IAM contracts (T4.16)", () => {
  it("parses each v1 permission and rejects a misspelling, a short name, and a capital", () => {
    expect(PERMISSIONS_V1).toHaveLength(12);
    for (const permission of PERMISSIONS_V1) {
      expect(Permission.parse(permission)).toBe(permission);
      expect(PermissionV1.parse(permission)).toBe(permission);
    }
    for (const bad of ["rehersal:read:plan", "rehearsal:read", "Rehearsal:read:plan"]) {
      expect(Permission.safeParse(bad).success).toBe(false);
      expect(PermissionV1.safeParse(bad).success).toBe(false);
    }
  });

  it("parses a rule file with one eq check", () => {
    expect(AuthzRuleFile.parse(ruleFile).rules[0]?.abac).toEqual([
      { eq: ["subject.orgId", "resource.orgId"] },
    ]);
  });

  it("rejects an unknown check key, including one nested under some", () => {
    expect(AuthzCheck.safeParse({ nope: "x" }).success).toBe(false);
    expect(
      AuthzRuleFile.safeParse({
        ...ruleFile,
        rules: [{ ...ruleFile.rules[0], abac: [{ nope: "x" }] }],
      }).success,
    ).toBe(false);
    expect(
      AuthzCheck.safeParse({
        some: { in: "resource.grants", where: [{ nope: "x" }] },
      }).success,
    ).toBe(false);
  });

  it("parses a some check that nests an eq", () => {
    expect(
      AuthzCheck.parse({
        some: {
          in: "resource.grants",
          where: [{ eq: ["item.orgId", "resource.orgId"] }],
        },
      }),
    ).toEqual({
      some: {
        in: "resource.grants",
        where: [{ eq: ["item.orgId", "resource.orgId"] }],
      },
    });
  });

  it("parses the draft's other checks, and keeps comparison operands as strings", () => {
    expect(
      AuthzRule.parse({
        action: "POST /api/plans/:id/approvals",
        rbac: { allOf: "resource.requiredPermissions" },
        abac: [
          { eq: ["subject.orgId", "resource.orgId"] },
          { eq: ["resource.dualRequired", "true"] },
        ],
      }).rbac,
    ).toEqual({ allOf: "resource.requiredPermissions" });
    expect(AuthzCheck.safeParse({ eq: ["resource.dualRequired", false] }).success).toBe(false);

    const admit = AuthzRule.parse({
      action: "run:admit",
      rbac: {},
      abac: [
        { eq: ["resource.dualRequired", "false"] },
        {
          some: {
            in: "resource.grants",
            where: [
              { isNull: "item.revokedAt" },
              { gt: ["item.expiresAt", "env.now"] },
              { allOf: ["item.permissions", "resource.requiredPermissions"] },
            ],
          },
        },
        {
          seats: {
            in: "resource.grants",
            where: [{ eq: ["item.orgId", "resource.orgId"] }],
            fill: ["rehearsal:approve:support_step", "rehearsal:approve:finance_step"],
            distinct: "actorUserId",
          },
        },
      ],
    });
    expect(admit.rbac).toEqual({});
    expect(admit.abac[2]).toMatchObject({
      seats: { distinct: "actorUserId" },
    });
  });

  it("parses a person request and a grants request, and refuses a person with no token", () => {
    expect(
      AuthzRequest.parse({ ...request, mode: { kind: "person", token: "sess_abc" } }).mode,
    ).toEqual({ kind: "person", token: "sess_abc" });
    expect(
      AuthzRequest.parse({
        ...request,
        action: "run:admit",
        mode: { kind: "grants" },
        resource: { orgId: "org_1", dualRequired: false, grants: [] },
      }).mode,
    ).toEqual({ kind: "grants" });
    expect(AuthzRequest.safeParse({ ...request, mode: { kind: "person" } }).success).toBe(false);
    expect(
      AuthzRequest.safeParse({ ...request, mode: { kind: "person", token: "" } }).success,
    ).toBe(false);
  });

  it("parses a decision and rejects an unknown effect", () => {
    const decision = {
      effect: "allow",
      action: "GET /api/plans",
      rule: { id: "rehearsal-authz", version: 1 },
      resource: { orgId: "org_1" },
      reason: "GET /api/plans matched rehearsal:read:plan",
    };
    expect(AuthzDecision.parse(decision).effect).toBe("allow");
    expect(AuthzDecision.safeParse({ ...decision, effect: "permit" }).success).toBe(false);
  });

  it("still parses a grant that only has roles, and one that also names permissions and a rule", () => {
    expect(ApprovalGrant.parse(grant).roles).toEqual(["support_lead"]);
    expect(ApprovalGrant.parse(grant).permissions).toBeUndefined();
    const withPermissions = ApprovalGrant.parse({
      ...grant,
      permissions: ["rehearsal:approve:support_step"],
      authzRule: { id: "rehearsal-authz", version: 1 },
    });
    expect(withPermissions.permissions).toEqual(["rehearsal:approve:support_step"]);
    expect(withPermissions.authzRule).toEqual({ id: "rehearsal-authz", version: 1 });
    expect(ApprovalGrant.safeParse({ ...grant, permissions: [] }).success).toBe(false);
    const { roles: _roles, ...noRoles } = grant;
    expect(ApprovalGrant.safeParse(noRoles).success).toBe(false);
  });
});
