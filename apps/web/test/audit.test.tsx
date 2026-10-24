import type { Receipt } from "@rehearsal/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Audit, AuditView } from "../src/components/AuditPanel";
import { fixtureBundles } from "../src/fixtures";

const HASH = "a".repeat(64);
const manifest = fixtureBundles[0]?.bundle.manifest ?? expect.unreachable();
const AT = "2026-10-22T12:00:00.000Z";

const receipt: Receipt = {
  id: "rcpt_1",
  actionId: "refund_001",
  planHash: HASH,
  approvalId: "grant_1",
  outcome: "confirmed",
  providerRef: { vendor: "stripe", kind: "refund", id: "re_1" },
  observedEffect: {},
  protection: "native_guard_with_documented_limits",
  holdReason: null,
  limitations: [],
  recordedAt: AT,
};

const audit = (policies: Audit["policies"]): Audit =>
  Audit.parse({
    source: "stored_history",
    run: {
      id: "run_1",
      planId: manifest.planId,
      revision: 1,
      planHash: HASH,
      approvalId: "grant_1",
      requestedBy: "user_fin",
      state: "completed",
      createdAt: AT,
      updatedAt: AT,
    },
    plan: { planId: manifest.planId, revision: 1, planHash: HASH, manifest },
    policies,
    grants: [
      {
        id: "grant_0",
        actorUserId: "user_sup",
        roles: ["support_lead"],
        grantedAt: AT,
        expiresAt: AT,
        revokedAt: AT,
        usedByRun: false,
      },
      {
        id: "grant_1",
        actorUserId: "user_fin",
        roles: ["finance_lead", "support_lead"],
        grantedAt: AT,
        expiresAt: AT,
        revokedAt: null,
        usedByRun: true,
      },
    ],
    attempts: [
      {
        id: "att_1",
        actionId: "refund_001",
        attemptNo: 1,
        state: "settled",
        providerStatus: 200,
        error: null,
        preparedAt: AT,
        settledAt: AT,
      },
    ],
    receipts: [{ id: "rcpt_1", actionId: "refund_001", receipt }],
  });

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");

describe("audit view (T2.14)", () => {
  const asApproved = {
    id: "billing-remedy",
    version: 1,
    contents: { financeThresholdMinor: 10000 },
  };

  it("shows the policy exactly as it was approved, not a policy loaded now", () => {
    const words = text(renderToStaticMarkup(<AuditView audit={audit([asApproved])} />));
    expect(words).toContain("billing-remedy version 1");
    expect(words).toContain('"financeThresholdMinor": 10000');
  });

  it("says when the approval kept no copy of the policy, instead of showing today's", () => {
    const html = renderToStaticMarkup(
      <AuditView audit={audit([{ id: "billing-remedy", version: 1, contents: null }])} />,
    );
    expect(html).toContain('data-testid="policy-not-recorded"');
    expect(text(html)).toContain("Today's policy file may differ");
    expect(html).not.toContain("financeThresholdMinor");
  });

  it("lists the plan, who approved and when, the sends and the receipts", () => {
    const words = text(renderToStaticMarkup(<AuditView audit={audit([asApproved])} />));
    expect(words).toContain(`revision 1, hash`);
    expect(words).toContain("refund_001");
    expect(words).toContain("$42.10 CAD");
    expect(words).toContain("user_fin");
    expect(words).toContain("Finance lead + Support lead");
    expect(words).toContain("Used by this run");
    expect(words).toContain("Revoked");
    expect(words).toContain("attempt 1");
    expect(words).toContain("provider answered 200");
    expect(words).toContain("refund re_1");
    expect(words).toContain("Saved history");
  });
});
