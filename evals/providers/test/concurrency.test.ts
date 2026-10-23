import { readFileSync } from "node:fs";
import type { PlanManifest } from "@rehearsal/contracts";
import { type BillingPolicyV1, executeRun, planHash } from "@rehearsal/core";
import {
  eraAdmin,
  stripeWriter,
  type WorldConfig,
  writeOnly,
  zendeskWriter,
} from "@rehearsal/providers";
import { billingManifest, FakeClock, MemoryApplyStore, MemoryJournal } from "@rehearsal/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import policy from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import {
  adminToken,
  ENABLED,
  getComments,
  getJson,
  resetScratchTenants,
  scratchWorld,
  uniqueTenant,
} from "../src/harness";

const FIXTURES = new URL("../../../scenarios/billing/fixtures/", import.meta.url);
const CASES = 4;
const chargeOf = (k: number) => `ch_rehearsalT37c${k}`;
const ticketOf = (k: number) => 4000000 + k;

/**
 * T3.7 on Era: four independent customer cases (own charge and ticket each) applied at once.
 * Every refund lands exactly once and every note names its own case's refund.
 */
describe.skipIf(!ENABLED)("independent cases applied concurrently on Era", () => {
  const tenant = uniqueTenant("t37");
  let stripe: WorldConfig;
  let zendesk: WorldConfig;

  beforeAll(async () => {
    stripe = await scratchWorld("stripe", "operational", tenant);
    zendesk = await scratchWorld("zendesk", "operational", tenant);
    const template = JSON.parse(readFileSync(new URL("stripe.charge.json", FIXTURES), "utf8"));
    const charges = Array.from({ length: CASES }, (_, k) => ({
      ...template,
      id: chargeOf(k),
      amount: 4210,
      amount_captured: 4210,
      currency: "cad",
    }));
    const res = await eraAdmin(stripe, adminToken(), "/inject", { charges });
    if (!res.ok) throw new Error(`inject → ${res.status} ${await res.text()}`);
  });
  afterAll(resetScratchTenants);

  it("applies every case once, at once", async () => {
    const base = billingManifest(`plan_t37_${tenant}`);
    const template = base.actions.filter((a) => a.caseId === "case_001" && a.id !== "patch_001");
    const manifest: PlanManifest = {
      ...base,
      actions: Array.from({ length: CASES }, (_, k) =>
        template.map((a) => {
          const copy = structuredClone(a);
          copy.id = `${a.id.replace("_001", "")}_${k}`;
          copy.caseId = `case_${k}`;
          copy.obligationId = `obl_${k}`;
          copy.dependsOn = a.dependsOn.map((d) => `${d.replace("_001", "")}_${k}`);
          if (copy.kind === "stripe.refund.create") copy.args.chargeId = chargeOf(k);
          else copy.args.ticketId = String(ticketOf(k));
          if (copy.kind === "zendesk.ticket.appendPrivateNote") {
            copy.args.bindings.refundId = {
              $ref: "result",
              stepId: `refund_${k}`,
              path: "refund.id",
            };
          }
          return copy;
        }),
      ).flat(),
    };
    const hash = planHash(manifest);
    const store = new MemoryApplyStore();
    store.runs.set("run", {
      planId: manifest.planId,
      revision: 1,
      planHash: hash,
      approvalId: "g",
    });
    store.plans.set(`${manifest.planId}@1`, { planHash: hash, manifest });
    store.grants.set("g", {
      id: "g",
      orgId: manifest.orgId,
      planId: manifest.planId,
      revision: 1,
      planHash: hash,
      actorUserId: "user_support",
      actorSessionId: "sess",
      roles: ["support_lead"],
      grantedAt: "2026-10-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      revokedAt: null,
    });
    let n = 0;
    const result = await executeRun(
      { orgId: manifest.orgId, runId: "run", planId: manifest.planId, revision: 1, planHash: hash },
      {
        store,
        journal: new MemoryJournal(),
        clock: new FakeClock("2026-10-22T12:00:00.000Z"),
        providers: {
          stripe: writeOnly(
            stripeWriter({
              world: "operational",
              config: stripe,
              authorization: "Bearer sk_test_t37",
            }),
          ),
          zendesk: writeOnly(
            zendeskWriter({ world: "operational", config: zendesk, authorization: "Bearer t37" }),
          ),
        },
        worlds: {
          stripe: { world: "operational", tenant },
          zendesk: { world: "operational", tenant },
        },
        policies: [policy as BillingPolicyV1],
        newId: (p) => `${p}_${++n}`,
        caseConcurrency: CASES,
      },
    );
    expect(result.error).toBeNull();
    expect(result.state).toBe("completed");
    for (let k = 0; k < CASES; k++) {
      const refunds = await getJson<{ data: Array<{ id: string }> }>(
        "stripe",
        stripe,
        `/v1/refunds?charge=${chargeOf(k)}&limit=100`,
      );
      expect(refunds.data).toHaveLength(1);
      const note = (await getComments(zendesk, ticketOf(k))).at(-1);
      expect(note?.public).toBe(false);
      expect(note?.body).toContain(refunds.data[0]?.id);
    }
  });
});
