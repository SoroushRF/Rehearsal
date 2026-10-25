import { AuthzRuleFile } from "@rehearsal/contracts";
import { describe, expect, it } from "vitest";
import { type AuthzSubject, decide, permissionsFor } from "../src";

const ORG = "org_1";
const OTHER_ORG = "org_2";
const NOW = new Date("2026-10-25T12:00:00.000Z");
const HASH = "sha256:abc";

const SUPPORT = "rehearsal:approve:support_step";
const FINANCE = "rehearsal:approve:finance_step";

const supportLead = [
  "rehearsal:read:plan",
  "rehearsal:read:run",
  "rehearsal:rehearse:incident",
  "rehearsal:revise:plan",
  SUPPORT,
  "rehearsal:apply:plan",
  "rehearsal:cancel:run",
  "rehearsal:revoke:own_grant",
];
const financeLead = [...supportLead, FINANCE, "rehearsal:revoke:any_grant"];
const owner = [...financeLead, "rehearsal:invite:member", "rehearsal:manage:role"];
const sameOrg = [{ eq: ["subject.orgId", "resource.orgId"] }];
const liveGrant = [
  { eq: ["item.orgId", "resource.orgId"] },
  { eq: ["item.planHash", "resource.planHash"] },
  { eq: ["item.revision", "resource.revision"] },
  { isNull: "item.revokedAt" },
  { gt: ["env.now", "item.grantedAt"] },
  { gt: ["item.expiresAt", "env.now"] },
];

const file = AuthzRuleFile.parse({
  id: "rehearsal-authz",
  version: 1,
  rolesFromClerk: {
    "org:owner": "owner",
    "org:finance_lead": "finance_lead",
    "org:support_lead": "support_lead",
    "org:member": "member",
  },
  roles: {
    owner,
    finance_lead: financeLead,
    support_lead: supportLead,
    member: ["rehearsal:read:plan", "rehearsal:read:run"],
  },
  rules: [
    { action: "GET /api/plans/:id", rbac: { anyOf: ["rehearsal:read:plan"] }, abac: sameOrg },
    {
      action: "POST /api/plans/:id/revisions",
      rbac: { anyOf: ["rehearsal:revise:plan"] },
      abac: sameOrg,
    },
    {
      action: "POST /api/plans/:id/approvals",
      rbac: { allOf: "resource.requiredPermissions" },
      abac: [...sameOrg, { eq: ["resource.dualRequired", "false"] }],
    },
    {
      action: "POST /api/plans/:id/approvals",
      rbac: { anyOf: [SUPPORT, FINANCE] },
      abac: [...sameOrg, { eq: ["resource.dualRequired", "true"] }],
    },
    {
      action: "POST /api/plans/:id/approvals/:grantId/revoke",
      rbac: { anyOf: ["rehearsal:revoke:own_grant"] },
      abac: [...sameOrg, { eq: ["subject.userId", "resource.grant.actorUserId"] }],
    },
    {
      action: "POST /api/plans/:id/approvals/:grantId/revoke",
      rbac: { anyOf: ["rehearsal:revoke:any_grant"] },
      abac: sameOrg,
    },
    {
      action: "POST /api/members/invitations",
      rbac: { anyOf: ["rehearsal:invite:member"] },
      abac: sameOrg,
    },
    {
      action: "run:admit",
      rbac: {},
      abac: [
        { eq: ["resource.dualRequired", "false"] },
        {
          some: {
            in: "resource.grants",
            where: [...liveGrant, { allOf: ["item.permissions", "resource.requiredPermissions"] }],
          },
        },
      ],
    },
    {
      action: "run:admit",
      rbac: {},
      abac: [
        { eq: ["resource.dualRequired", "true"] },
        {
          seats: {
            in: "resource.grants",
            where: liveGrant,
            fill: [SUPPORT, FINANCE],
            distinct: "actorUserId",
          },
        },
      ],
    },
  ],
});

type ClerkRole = "org:owner" | "org:finance_lead" | "org:support_lead" | "org:member";

function as(clerkRole: string | null, userId = "user_a", orgId = ORG): AuthzSubject {
  return { userId, orgId, clerkRole };
}

function run(
  action: string,
  subject: AuthzSubject | null,
  resource: Record<string, unknown>,
  now = NOW,
) {
  return decide({ file, action, subject, resource, now });
}

describe("permissionsFor", () => {
  it.each([
    ["org:owner", owner],
    ["org:finance_lead", financeLead],
    ["org:support_lead", supportLead],
    ["org:member", ["rehearsal:read:plan", "rehearsal:read:run"]],
    ["org:admin", []],
    ["toString", []],
    [null, []],
  ])("%s", (clerkRole, expected) => {
    expect(permissionsFor(file, clerkRole)).toEqual(expected);
  });
});

describe("person rules by role", () => {
  const roles: ClerkRole[] = ["org:owner", "org:finance_lead", "org:support_lead", "org:member"];
  const financeApproval = { orgId: ORG, requiredPermissions: [FINANCE], dualRequired: false };
  const supportApproval = { orgId: ORG, requiredPermissions: [SUPPORT], dualRequired: false };

  const table: [string, Record<string, unknown>, ClerkRole[]][] = [
    ["GET /api/plans/:id", { orgId: ORG }, roles],
    ["POST /api/plans/:id/revisions", { orgId: ORG }, roles.slice(0, 3)],
    ["POST /api/plans/:id/approvals", financeApproval, ["org:owner", "org:finance_lead"]],
    ["POST /api/plans/:id/approvals", supportApproval, roles.slice(0, 3)],
    ["POST /api/members/invitations", { orgId: ORG }, ["org:owner"]],
  ];

  for (const [action, resource, allowed] of table) {
    for (const role of roles) {
      const effect = allowed.includes(role) ? "allow" : "deny";
      it(`${action} ${JSON.stringify(resource.requiredPermissions ?? "")} as ${role}: ${effect}`, () => {
        expect(run(action, as(role), resource).effect).toBe(effect);
      });
    }
  }

  it("names the failing check", () => {
    const invite = run("POST /api/members/invitations", as("org:finance_lead"), { orgId: ORG });
    expect(invite).toEqual({
      effect: "deny",
      reason: "rule 6: subject lacks rehearsal:invite:member",
      ruleIndex: null,
    });
    const single = run("GET /api/plans/:id", as("org:member", "u", OTHER_ORG), { orgId: ORG });
    expect(single.reason).toBe("rule 0: subject.orgId != resource.orgId");
  });

  it("reports the allowing rule", () => {
    expect(run("GET /api/plans/:id", as("org:member"), { orgId: ORG })).toEqual({
      effect: "allow",
      reason: "rule 0 allows GET /api/plans/:id",
      ruleIndex: 0,
    });
  });
});

describe("person rules deny", () => {
  const actions: [string, Record<string, unknown>][] = [
    ["GET /api/plans/:id", { orgId: ORG }],
    ["POST /api/plans/:id/revisions", { orgId: ORG }],
    [
      "POST /api/plans/:id/approvals",
      { orgId: ORG, requiredPermissions: [SUPPORT], dualRequired: false },
    ],
    [
      "POST /api/plans/:id/approvals",
      { orgId: ORG, requiredPermissions: [SUPPORT], dualRequired: true },
    ],
    [
      "POST /api/plans/:id/approvals/:grantId/revoke",
      { orgId: ORG, grant: { actorUserId: "user_a" } },
    ],
    ["POST /api/members/invitations", { orgId: ORG }],
  ];

  it.each(actions)("%s in another org", (action, resource) => {
    expect(run(action, as("org:owner", "user_a", OTHER_ORG), resource).effect).toBe("deny");
  });

  it.each(actions)("%s with an unmapped Clerk role", (action, resource) => {
    expect(run(action, as("org:admin"), resource).effect).toBe("deny");
    expect(run(action, as(null), resource).effect).toBe("deny");
  });

  it.each(actions)("%s without a subject", (action, resource) => {
    expect(run(action, null, resource).effect).toBe("deny");
  });
});

describe("approval", () => {
  const action = "POST /api/plans/:id/approvals";

  it.each([
    ["empty", []],
    ["missing", undefined],
    ["a string", FINANCE],
    ["an object", { 0: FINANCE }],
    ["a list with a non-string", [FINANCE, 1]],
  ])("single mode with requiredPermissions %s: deny", (_label, requiredPermissions) => {
    const resource = { orgId: ORG, requiredPermissions, dualRequired: false };
    expect(run(action, as("org:owner"), resource).effect).toBe("deny");
  });

  it.each([
    ["org:support_lead", "allow"],
    ["org:finance_lead", "allow"],
    ["org:owner", "allow"],
    ["org:member", "deny"],
  ])("dual mode as %s: %s", (role, effect) => {
    const resource = { orgId: ORG, requiredPermissions: [SUPPORT, FINANCE], dualRequired: true };
    expect(run(action, as(role), resource).effect).toBe(effect);
  });

  it("reports the rule whose facts applied, not the two-person alternative", () => {
    const resource = { orgId: ORG, requiredPermissions: [FINANCE], dualRequired: false };
    const decision = run(action, as("org:support_lead"), resource);
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toContain(`subject lacks ${FINANCE}`);
    expect(decision.reason).not.toContain("dualRequired");
    expect(decision.reason).toBe(`rule 2: subject lacks ${FINANCE}`);
  });

  it("falls back to the last failure when no rule's facts applied", () => {
    const resource = { orgId: ORG, requiredPermissions: [FINANCE], dualRequired: false };
    const decision = run(action, as("org:owner", "user_a", OTHER_ORG), resource);
    expect(decision.reason).toBe("rule 3: subject.orgId != resource.orgId");
  });

  it("dualRequired that is not a boolean: deny", () => {
    const resource = { orgId: ORG, requiredPermissions: [SUPPORT], dualRequired: "false" };
    expect(run(action, as("org:owner"), resource).effect).toBe("deny");
  });
});

describe("revoke", () => {
  const action = "POST /api/plans/:id/approvals/:grantId/revoke";
  it.each([
    ["support revokes own", "org:support_lead", "user_a", "allow"],
    ["support revokes another's", "org:support_lead", "user_b", "deny"],
    ["finance revokes another's", "org:finance_lead", "user_b", "allow"],
    ["owner revokes another's", "org:owner", "user_b", "allow"],
    ["member revokes own", "org:member", "user_a", "deny"],
  ])("%s: %s", (_label, role, actorUserId, effect) => {
    const resource = { orgId: ORG, grant: { actorUserId } };
    expect(run(action, as(role, "user_a"), resource).effect).toBe(effect);
  });

  it.each([
    ["support revokes another's", "org:support_lead", "user_b"],
    ["member revokes own", "org:member", "user_a"],
  ])("%s: the last rule whose facts applied explains the deny", (_label, role, actorUserId) => {
    const resource = { orgId: ORG, grant: { actorUserId } };
    expect(run(action, as(role, "user_a"), resource).reason).toBe(
      "rule 5: subject lacks rehearsal:revoke:any_grant",
    );
  });

  it("grant actor that is an object: deny", () => {
    const resource = { orgId: ORG, grant: { actorUserId: { id: "user_a" } } };
    expect(run(action, as("org:support_lead"), resource).effect).toBe("deny");
  });
});

interface Grant {
  actorUserId: unknown;
  orgId: unknown;
  planHash: unknown;
  revision: unknown;
  revokedAt: unknown;
  grantedAt: unknown;
  expiresAt: unknown;
  permissions: unknown;
}

function grant(overrides: Partial<Grant> = {}): Grant {
  return {
    actorUserId: "user_a",
    orgId: ORG,
    planHash: HASH,
    revision: 2,
    revokedAt: null,
    grantedAt: "2026-10-25T11:00:00.000Z",
    expiresAt: "2026-10-25T13:00:00.000Z",
    permissions: [SUPPORT, FINANCE],
    ...overrides,
  };
}

function admit(grants: unknown, dualRequired: boolean, requiredPermissions = [FINANCE], now = NOW) {
  const resource = {
    orgId: ORG,
    planHash: HASH,
    revision: 2,
    dualRequired,
    requiredPermissions,
    grants,
  };
  return run("run:admit", null, resource, now);
}

describe("run:admit single", () => {
  it("one live grant covers: allow", () => {
    expect(admit([grant()], false)).toMatchObject({ effect: "allow", ruleIndex: 7 });
  });

  it.each<[string, Partial<Grant>]>([
    ["revoked", { revokedAt: "2026-10-25T11:30:00.000Z" }],
    ["revokedAt missing", { revokedAt: undefined }],
    ["expired", { expiresAt: "2026-10-25T11:59:59.000Z" }],
    ["future-dated", { grantedAt: "2026-10-25T12:00:01.000Z" }],
    ["unparseable time", { grantedAt: "yesterday" }],
    ["wrong hash", { planHash: "sha256:def" }],
    ["wrong revision", { revision: 3 }],
    ["wrong org", { orgId: OTHER_ORG }],
    ["missing a required permission", { permissions: [SUPPORT] }],
    ["permissions not a list", { permissions: FINANCE }],
    ["orgId an object", { orgId: { id: ORG } }],
  ])("%s: deny", (_label, overrides) => {
    expect(admit([grant(overrides)], false).effect).toBe("deny");
  });

  it("empty requiredPermissions never allow", () => {
    expect(admit([grant()], false, []).effect).toBe("deny");
  });

  it("grants not a list: deny", () => {
    expect(admit({ 0: grant() }, false).effect).toBe("deny");
    expect(admit(undefined, false).effect).toBe("deny");
  });

  it("one bad grant beside a good one still allows", () => {
    expect(admit([grant({ revision: 1 }), grant()], false).effect).toBe("allow");
  });
});

describe("run:admit dual", () => {
  const support = (actorUserId: string, overrides: Partial<Grant> = {}) =>
    grant({ actorUserId, permissions: [SUPPORT], ...overrides });
  const finance = (actorUserId: string, overrides: Partial<Grant> = {}) =>
    grant({ actorUserId, permissions: [FINANCE], ...overrides });
  const both = (actorUserId: string) => grant({ actorUserId, permissions: [SUPPORT, FINANCE] });

  it.each<[string, Grant[], "allow" | "deny"]>([
    ["support + finance, different users", [support("user_a"), finance("user_b")], "allow"],
    ["one user with both, alone", [both("user_a")], "deny"],
    ["one user with both, two grants", [both("user_a"), both("user_a")], "deny"],
    ["two users with only support", [support("user_a"), support("user_b")], "deny"],
    ["both + another with support", [both("user_a"), support("user_b")], "allow"],
    ["support + both, support first", [support("user_b"), both("user_a")], "allow"],
    [
      "finance grant revoked",
      [support("user_a"), finance("user_b", { revokedAt: "2026-10-25T11:30:00.000Z" })],
      "deny",
    ],
    [
      "finance grant expired",
      [support("user_a"), finance("user_b", { expiresAt: NOW.toISOString() })],
      "deny",
    ],
    ["finance grant wrong hash", [support("user_a"), finance("user_b", { planHash: "x" })], "deny"],
    [
      "actorUserId missing",
      [support("user_a"), finance("user_b", { actorUserId: undefined })],
      "deny",
    ],
    ["actorUserId a number", [support("user_a"), finance("user_b", { actorUserId: 7 })], "deny"],
  ])("%s: %s", (_label, grants, effect) => {
    expect(admit(grants, true).effect).toBe(effect);
  });

  it("names the seats that cannot be filled", () => {
    expect(admit([both("user_a")], true).reason).toBe(
      `rule 8: resource.grants cannot fill ${SUPPORT}, ${FINANCE} with different actorUserId`,
    );
  });
});

describe("mode guard", () => {
  it("run:admit with a subject: deny", () => {
    const decision = decide({
      file,
      action: "run:admit",
      subject: as("org:owner"),
      resource: {
        orgId: ORG,
        planHash: HASH,
        revision: 2,
        dualRequired: false,
        requiredPermissions: [FINANCE],
        grants: [grant()],
      },
      now: NOW,
    });
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toContain("takes no subject");
  });

  it("a person rule with no subject: deny", () => {
    const decision = run("GET /api/plans/:id", null, { orgId: ORG });
    expect(decision).toEqual({
      effect: "deny",
      reason: "rule 0: rule needs a subject, but none was given",
      ruleIndex: null,
    });
  });
});

describe("never throws", () => {
  it("unknown action", () => {
    expect(run("DELETE /api/everything", as("org:owner"), { orgId: ORG })).toEqual({
      effect: "deny",
      reason: "no rule for DELETE /api/everything",
      ruleIndex: null,
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ["orgId an object", { orgId: { id: ORG } }],
    ["orgId an array", { orgId: [ORG] }],
    ["orgId missing", {}],
    ["orgId through the prototype", Object.create({ orgId: ORG })],
  ])("%s: deny", (_label, resource) => {
    expect(run("GET /api/plans/:id", as("org:owner"), resource).effect).toBe("deny");
  });

  it("a getter that throws becomes a deny", () => {
    const resource = {
      get orgId(): string {
        throw new Error("boom");
      },
    };
    expect(run("GET /api/plans/:id", as("org:owner"), resource)).toEqual({
      effect: "deny",
      reason: "error: boom",
      ruleIndex: null,
    });
  });

  it("an invalid clock becomes a deny", () => {
    expect(admit([grant()], false).effect).toBe("allow");
    expect(admit([grant()], false, [FINANCE], new Date(Number.NaN)).effect).toBe("deny");
  });

  it("a revision given as a string does not equal a numeric one", () => {
    expect(admit([grant({ revision: "2" })], false).effect).toBe("deny");
  });

  it("checks nested past the depth bound: deny", () => {
    let check: unknown = { eq: ["true", "true"] };
    for (let i = 0; i < 20; i++) check = { some: { in: "resource.list", where: [check] } };
    const deep = AuthzRuleFile.parse({
      ...file,
      rules: [{ action: "deep", rbac: {}, abac: [check] }],
    });
    const shallow = AuthzRuleFile.parse({
      ...file,
      rules: [
        {
          action: "deep",
          rbac: {},
          abac: [{ some: { in: "resource.list", where: [{ eq: ["true", "true"] }] } }],
        },
      ],
    });
    expect(
      decide({ file: shallow, action: "deep", subject: null, resource: { list: [1] }, now: NOW })
        .effect,
    ).toBe("allow");
    const decision = decide({
      file: deep,
      action: "deep",
      subject: null,
      resource: { list: [1] },
      now: NOW,
    });
    expect(decision.effect).toBe("deny");
  });

  it("literals: numbers, booleans and null", () => {
    const literals = AuthzRuleFile.parse({
      ...file,
      rules: [
        {
          action: "lit",
          rbac: {},
          abac: [
            { eq: ["resource.n", "-1.5"] },
            { gt: ["resource.n", "-2"] },
            { eq: ["resource.b", "true"] },
            { eq: ["resource.z", "null"] },
            { isNull: "resource.z" },
            { eq: ["resource.s", "plain"] },
          ],
        },
      ],
    });
    const resource = { n: -1.5, b: true, z: null, s: "plain" };
    const ok = decide({ file: literals, action: "lit", subject: null, resource, now: NOW });
    expect(ok.effect).toBe("allow");
    const missingNull = decide({
      file: literals,
      action: "lit",
      subject: null,
      resource: { ...resource, z: undefined },
      now: NOW,
    });
    expect(missingNull.effect).toBe("deny");
  });
});
