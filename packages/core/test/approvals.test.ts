import type { ApprovalGrant, Role } from "@rehearsal/contracts";
import { describe, expect, it } from "vitest";
import {
  approvalStatus,
  type BillingPolicy,
  dualApprovalStatus,
  evaluateBillingPolicy,
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

const grant = (id: string, user: string, roles: Role[], over: Partial<ApprovalGrant> = {}) =>
  ({
    id,
    orgId: "org_1",
    planId: "plan_1",
    revision: 1,
    planHash: HASH,
    actorUserId: user,
    actorSessionId: `sess_${user}`,
    roles,
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
  it("is satisfied by a support lead and a different finance lead", () => {
    const s = dualApprovalStatus([
      grant("g1", "sup", ["support_lead"]),
      grant("g2", "fin", ["finance_lead"]),
    ]);
    expect(s).toMatchObject({ satisfied: true, needed: [] });
    expect(s.signed.map((x) => [x.role, x.actorUserId])).toEqual([
      ["support_lead", "sup"],
      ["finance_lead", "fin"],
    ]);
  });

  it("is satisfied when one person holds both roles but another fills a seat", () => {
    const s = dualApprovalStatus([
      grant("g1", "boss", ["support_lead", "finance_lead"]),
      grant("g2", "sup", ["support_lead"]),
    ]);
    expect(s.satisfied).toBe(true);
    expect(s.signed.map((x) => [x.role, x.actorUserId])).toEqual([
      ["support_lead", "sup"],
      ["finance_lead", "boss"],
    ]);
  });

  it("is not satisfied by one person holding both roles, however many times they sign", () => {
    const s = dualApprovalStatus([
      grant("g1", "boss", ["support_lead", "finance_lead"]),
      grant("g2", "boss", ["support_lead", "finance_lead"], { actorSessionId: "other" }),
    ]);
    expect(s).toMatchObject({ satisfied: false, needed: ["support_lead"] });
    expect(s.signed).toEqual([{ role: "finance_lead", grantId: "g1", actorUserId: "boss" }]);
  });

  it("names the open seat for a lone approver, and both for none", () => {
    expect(dualApprovalStatus([grant("g1", "sup", ["support_lead"])]).needed).toEqual([
      "finance_lead",
    ]);
    expect(dualApprovalStatus([grant("g1", "fin", ["finance_lead"])]).needed).toEqual([
      "support_lead",
    ]);
    expect(dualApprovalStatus([])).toMatchObject({
      satisfied: false,
      needed: ["support_lead", "finance_lead"],
      signed: [],
    });
  });
});

describe("liveGrantsFor and approvalStatus", () => {
  const plan = { orgId: "org_1", planId: "plan_1", revision: 1, planHash: HASH };
  const sup = grant("g1", "sup", ["support_lead"]);
  const fin = grant("g2", "fin", ["finance_lead"]);

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
      needed: ["support_lead"],
    });
    expect(approvalStatus(flagged, HASH, [V1, V3], [fin, sup], AT).satisfied).toBe(true);
  });
});
