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
  resetScratchTenants,
  scratchWorld,
  stripePost,
  uniqueTenant,
} from "../src/harness";

const FIXTURES = new URL("../../../scenarios/billing/fixtures/", import.meta.url);
const CHARGE_ID = "ch_rehearsalT36ids1";
const OTHER_CHARGE = "ch_rehearsalT36oth1";
const TICKET = 4000003;

/**
 * T3.6 gate: fork and production mint the same refund IDs from the same seed (capability matrix
 * surprise 5), so a remapper test must force them apart. The refund is rehearsed in the planning
 * world, the operational world's counter is pushed on, and the plan is applied: the note must name
 * the operational refund, never the rehearsed one.
 */
describe.skipIf(!ENABLED)("plan-time and applied IDs diverge", () => {
  const tenant = uniqueTenant("t36");
  let planning: WorldConfig;
  let operational: WorldConfig;
  let zendesk: WorldConfig;

  beforeAll(async () => {
    planning = await scratchWorld("stripe", "planning", tenant);
    operational = await scratchWorld("stripe", "operational", tenant);
    zendesk = await scratchWorld("zendesk", "operational", tenant);
    const template = JSON.parse(readFileSync(new URL("stripe.charge.json", FIXTURES), "utf8"));
    const charge = (id: string) => ({
      ...template,
      id,
      amount: 4210,
      amount_captured: 4210,
      currency: "cad",
    });
    for (const world of [planning, operational]) {
      const res = await eraAdmin(world, adminToken(), "/inject", {
        charges: [charge(CHARGE_ID), charge(OTHER_CHARGE)],
      });
      if (!res.ok) throw new Error(`inject → ${res.status} ${await res.text()}`);
    }
  });
  afterAll(resetScratchTenants);

  it("the note carries the operational refund ID, not the rehearsed one", async () => {
    // The rehearsal: the same refund in the planning world.
    const rehearsed = await stripePost(
      planning,
      "/v1/refunds",
      `charge=${CHARGE_ID}&amount=4210&reason=duplicate`,
      `rehearsal-${tenant}`,
    );
    const planningRefund = ((await rehearsed.json()) as { id: string }).id;

    // Production has moved on: an unrelated refund advances its ID counter. It takes exactly the
    // ID the rehearsal minted, which proves the twin worlds would otherwise collide.
    const push = await stripePost(operational, "/v1/refunds", `charge=${OTHER_CHARGE}&amount=100`);
    expect(((await push.json()) as { id: string }).id).toBe(planningRefund);

    const base = billingManifest(`plan_t36_${tenant}`);
    const manifest: PlanManifest = {
      ...base,
      actions: base.actions
        .filter((a) => a.id === "refund_001" || a.id === "note_001")
        .map((a) => {
          const copy = structuredClone(a);
          if (copy.kind === "stripe.refund.create") copy.args.chargeId = CHARGE_ID;
          else if (copy.kind !== "slack.message.postSummary") copy.args.ticketId = String(TICKET);
          return copy;
        }),
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
              config: operational,
              authorization: "Bearer sk_test_t36",
            }),
          ),
          zendesk: writeOnly(
            zendeskWriter({ world: "operational", config: zendesk, authorization: "Bearer t36" }),
          ),
        },
        worlds: {
          stripe: { world: "operational", tenant },
          zendesk: { world: "operational", tenant },
        },
        policies: [policy as BillingPolicyV1],
        newId: (p) => `${p}_${++n}`,
      },
    );
    expect(result.state).toBe("completed");
    const appliedRefund = result.receipts.find((r) => r.actionId === "refund_001")?.providerRef?.id;
    expect(appliedRefund).toBeDefined();
    expect(appliedRefund).not.toBe(planningRefund);

    const note = (await getComments(zendesk, TICKET)).at(-1);
    expect(note?.public).toBe(false);
    expect(note?.body).toContain(appliedRefund);
    expect(note?.body).not.toContain(planningRefund);
  });
});
