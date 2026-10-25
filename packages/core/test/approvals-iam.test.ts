import { decide } from "@rehearsal/authz";
import { type ApprovalGrant, AuthzRuleFile, type PermissionV1 } from "@rehearsal/contracts";
import { describe, expect, it } from "vitest";
import raw from "../../../scenarios/authz/rehearsal-authz.v1.json" with { type: "json" };
import { dualApprovalStatus, liveGrantsFor } from "../src";

/**
 * Two places can judge "two different people": `dualApprovalStatus` here (the API and the apply
 * request) and the `seats` rule IAM evaluates for `run:admit`. Decision 0014 wants one answer, so
 * every case in the refusal matrix from T2.13 runs through both and they must agree.
 */

const file = AuthzRuleFile.parse(raw);
const HASH = "a".repeat(64);
const NOW = new Date("2026-10-24T12:00:00.000Z");
const PLAN = { orgId: "org_1", planId: "plan_1", revision: 1, planHash: HASH };

const grant = (
  id: string,
  user: string,
  permissions: PermissionV1[] | undefined,
  over: Partial<ApprovalGrant> = {},
): ApprovalGrant => ({
  id,
  ...PLAN,
  actorUserId: user,
  actorSessionId: `sess_${user}`,
  roles: ["support_lead"],
  ...(permissions === undefined ? {} : { permissions }),
  grantedAt: "2026-10-24T11:00:00.000Z",
  expiresAt: "2026-10-24T13:00:00.000Z",
  revokedAt: null,
  ...over,
});

const SUP: PermissionV1[] = ["rehearsal:approve:support_step"];
const FIN: PermissionV1[] = ["rehearsal:approve:finance_step"];
const BOTH: PermissionV1[] = [...SUP, ...FIN];

const cases: [string, ApprovalGrant[], boolean][] = [
  [
    "a support lead and a different finance lead",
    [grant("1", "a", SUP), grant("2", "b", FIN)],
    true,
  ],
  [
    "one person holding both, and a different support lead",
    [grant("1", "boss", BOTH), grant("2", "a", SUP)],
    true,
  ],
  ["one person holding both permissions", [grant("1", "boss", BOTH)], false],
  [
    "one person holding both permissions, signing twice",
    [grant("1", "boss", BOTH), grant("2", "boss", BOTH)],
    false,
  ],
  ["the same permission twice", [grant("1", "a", SUP), grant("2", "b", SUP)], false],
  ["a missing seat", [grant("1", "a", FIN)], false],
  ["no grants", [], false],
  [
    "a revoked seat",
    [grant("1", "a", SUP), grant("2", "b", FIN, { revokedAt: "2026-10-24T11:30:00.000Z" })],
    false,
  ],
  [
    "an expired seat",
    [grant("1", "a", SUP), grant("2", "b", FIN, { expiresAt: "2026-10-24T11:59:59.000Z" })],
    false,
  ],
  [
    "a seat dated in the future",
    [grant("1", "a", SUP), grant("2", "b", FIN, { grantedAt: "2026-10-24T12:00:01.000Z" })],
    false,
  ],
  [
    "a stale hash",
    [grant("1", "a", SUP), grant("2", "b", FIN, { planHash: "b".repeat(64) })],
    false,
  ],
  ["another revision", [grant("1", "a", SUP), grant("2", "b", FIN, { revision: 2 })], false],
  ["another org", [grant("1", "a", SUP), grant("2", "b", FIN, { orgId: "org_2" })], false],
  [
    "recorded permissions over roles",
    [
      grant("1", "a", SUP, { permissions: ["rehearsal:approve:support_step"] }),
      grant("2", "b", BOTH, {
        roles: ["support_lead", "finance_lead"],
        permissions: ["rehearsal:read:plan"],
      }),
    ],
    false,
  ],
  [
    "a permission grant beside a role-only grant does not fill both seats",
    [
      grant("1", "a", undefined),
      grant("2", "b", FIN, { permissions: ["rehearsal:approve:finance_step"] }),
    ],
    false,
  ],
  [
    "two role-only grants fill no seats",
    [grant("1", "a", undefined), grant("2", "b", undefined, { roles: ["finance_lead"] })],
    false,
  ],
];

describe("one answer for 'two different people'", () => {
  it.each(cases)("%s", (_label, grants, expected) => {
    const app = dualApprovalStatus(liveGrantsFor(grants, PLAN, NOW)).satisfied;
    const iam = decide({
      file,
      action: "run:admit",
      subject: null,
      resource: {
        ...PLAN,
        dualRequired: true,
        requiredPermissions: [],
        // Pass the saved grants unchanged: missing permissions must not be inferred from roles.
        grants,
      },
      now: NOW,
    });
    expect(app).toBe(expected);
    expect(iam.effect === "allow").toBe(expected);
  });
});
