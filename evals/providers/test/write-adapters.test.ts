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
  getTicket,
  resetScratchTenants,
  SEED,
  scratchWorld,
  uniqueTenant,
} from "../src/harness";

const FIXTURES = new URL("../../../scenarios/billing/fixtures/", import.meta.url);
const CHARGE_ID = "ch_rehearsalT33cad1";

interface Refund {
  id: string;
  amount: number;
  charge: string;
  metadata: Record<string, string>;
}

/**
 * T3.3 gate: the executor applies one case (refund → guarded priority patch → private note) to a
 * real operational world through the Era write adapters, and every step ends in a receipt.
 * The seeded charges are USD and policy v1 is CAD, so the test injects a CAD charge first.
 */
describe.skipIf(!ENABLED)("Era write adapters through the executor", () => {
  let stripe: WorldConfig;
  let zendesk: WorldConfig;
  let manifest: PlanManifest;

  beforeAll(async () => {
    const tenant = uniqueTenant("t33");
    stripe = await scratchWorld("stripe", "operational", tenant);
    zendesk = await scratchWorld("zendesk", "operational", tenant);

    const template = JSON.parse(readFileSync(new URL("stripe.charge.json", FIXTURES), "utf8"));
    const charge = {
      ...template,
      id: CHARGE_ID,
      amount: 4210,
      amount_captured: 4210,
      currency: "cad",
    };
    const res = await eraAdmin(stripe, adminToken(), "/inject", { charges: [charge] });
    if (!res.ok) throw new Error(`inject → ${res.status} ${await res.text()}`);

    const ticket = await getTicket(zendesk, SEED.ticketId);
    const base = billingManifest(`plan_t33_${tenant}`);
    manifest = {
      ...base,
      actions: base.actions
        .filter((a) => a.caseId === "case_001")
        .map((a) => {
          const copy = structuredClone(a);
          if (copy.kind === "stripe.refund.create") copy.args.chargeId = CHARGE_ID;
          else copy.args.ticketId = String(SEED.ticketId);
          if (copy.kind === "zendesk.ticket.patchFields") {
            copy.args.before = { priority: ticket.priority as "low" };
          }
          return copy;
        }),
    };
  });

  afterAll(resetScratchTenants);

  it("applies refund, patch and note, each with a confirmed receipt", async () => {
    const hash = planHash(manifest);
    const store = new MemoryApplyStore();
    store.runs.set("run_t33", {
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
    const journal = new MemoryJournal();
    let n = 0;
    const result = await executeRun(
      {
        orgId: manifest.orgId,
        runId: "run_t33",
        planId: manifest.planId,
        revision: 1,
        planHash: hash,
      },
      {
        store,
        journal,
        clock: new FakeClock("2026-10-21T12:00:00.000Z"),
        providers: {
          stripe: writeOnly(
            stripeWriter({
              world: "operational",
              config: stripe,
              authorization: "Bearer sk_test_t33",
            }),
          ),
          zendesk: writeOnly(
            zendeskWriter({ world: "operational", config: zendesk, authorization: "Bearer t33" }),
          ),
        },
        worlds: {
          stripe: { world: "operational", tenant: stripe.tenant },
          zendesk: { world: "operational", tenant: zendesk.tenant },
        },
        policies: [policy as BillingPolicyV1],
        newId: (p) => `${p}_${++n}`,
      },
    );

    expect(result.error).toBeNull();
    expect(result.state).toBe("completed");
    expect(result.receipts.map((r) => [r.actionId, r.outcome])).toEqual([
      ["refund_001", "confirmed"],
      ["patch_001", "confirmed"],
      ["note_001", "confirmed"],
    ]);

    // The world agrees with the receipts: one refund carrying our operation key...
    const refunds = (
      await getJson<{ data: Refund[] }>(
        "stripe",
        stripe,
        `/v1/refunds?charge=${CHARGE_ID}&limit=100`,
      )
    ).data;
    expect(refunds).toHaveLength(1);
    const [refund] = refunds;
    const [refundAttempt] = await journal.attemptsFor(hash, "refund_001");
    expect(refund?.metadata.rehearsal_op).toBe(refundAttempt?.operationKey);
    expect(result.receipts[0]?.providerRef).toEqual({
      vendor: "stripe",
      kind: "refund",
      id: refund?.id,
    });

    // ...the guarded patch landed and its receipt says what the ticket now holds...
    expect((await getTicket(zendesk, SEED.ticketId)).priority).toBe("high");
    expect(result.receipts[1]?.observedEffect.priority).toBe("high");
    const [patchAttempt] = await journal.attemptsFor(hash, "patch_001");
    expect(JSON.parse(patchAttempt?.request.body ?? "{}").ticket.safe_update).toBe(true);

    // ...and the private note names the refund ID the operational world returned.
    const last = (await getComments(zendesk, SEED.ticketId)).at(-1);
    expect(last?.public).toBe(false);
    expect(last?.body).toContain(refund?.id);
  });
});
