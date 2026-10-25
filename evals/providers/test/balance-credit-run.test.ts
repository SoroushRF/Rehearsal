import type { Action, PlanManifest } from "@rehearsal/contracts";
import { type BillingPolicyV2, type ExecutorDeps, executeRun, planHash } from "@rehearsal/core";
import { stripeWriter, type WorldConfig, writeOnly } from "@rehearsal/providers";
import { billingManifest, FakeClock, MemoryApplyStore, MemoryJournal } from "@rehearsal/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import policy from "../../../scenarios/billing/policy.v2.json" with { type: "json" };
import {
  ENABLED,
  getJson,
  resetScratchTenants,
  scratchWorld,
  stripePost,
  uniqueTenant,
} from "../src/harness";

interface Transaction {
  id: string;
  amount: number;
  currency: string;
  metadata: Record<string, string>;
}

/**
 * T1.14 on Era: a plan's balance credit goes out through the executor and `stripeWriter`, is read
 * back, and a response lost after Era applied it is reconciled from the customer's transactions on
 * the next delivery, not sent again. The customer is fresh, so it has no currency yet: the cohort's
 * customers are USD and would be refused (surprise 14). Needs `pnpm infra:up` and ERA_CONFORMANCE=1.
 */
describe.skipIf(!ENABLED)("balance credit through the executor on Era", () => {
  let stripe: WorldConfig;
  let customerId: string;

  beforeAll(async () => {
    stripe = await scratchWorld("stripe", "operational", uniqueTenant("t114"));
    const res = await stripePost(
      stripe,
      "/v1/customers",
      "email=t114%40example.com",
      uniqueTenant("cus"),
    );
    expect(res.status).toBe(200);
    customerId = ((await res.json()) as { id: string }).id;
  });
  afterAll(resetScratchTenants);

  const ours = async (operationKey: string) =>
    (
      await getJson<{ data: Transaction[] }>(
        "stripe",
        stripe,
        `/v1/customers/${customerId}/balance_transactions?limit=100`,
      )
    ).data.filter((t) => t.metadata.rehearsal_op === operationKey);

  function setup(planId: string, opts: { loseFirstResponse?: boolean } = {}) {
    const base = billingManifest(planId);
    const credit: Action = {
      id: "credit_001",
      kind: "stripe.customer.balanceCredit",
      caseId: "case_001",
      obligationId: "obl_overcharge_001",
      dependsOn: [],
      requiredRole: "support_lead",
      evidence: [],
      queryEvidence: [],
      compensation: "compensable_by_new_action",
      protection: "native_guard_with_documented_limits",
      rationale: "Small duplicate; credit the invoice balance.",
      args: {
        customerId,
        chargeId: "ch_rehearsalT114cad1",
        amount: { amountMinor: 4210, currency: "cad" },
      },
    };
    const manifest: PlanManifest = {
      ...base,
      policies: [{ id: "billing-remedy", version: 2 }],
      actions: [credit],
    };
    const hash = planHash(manifest);
    const store = new MemoryApplyStore();
    store.runs.set("run_t114", {
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
    const writer = writeOnly(
      stripeWriter({ world: "operational", config: stripe, authorization: "Bearer sk_test_t114" }),
    );
    let lose = opts.loseFirstResponse ?? false;
    const dispatch = writer.dispatch.bind(writer);
    // Era applies the credit; the executor never hears back, as on a dropped connection.
    writer.dispatch = async (req, ctx) => {
      const result = await dispatch(req, ctx);
      if (!lose) return result;
      lose = false;
      throw new Error("socket hang up");
    };
    let n = 0;
    const deps: ExecutorDeps = {
      store,
      journal,
      clock: new FakeClock("2026-10-21T12:00:00.000Z"),
      providers: { stripe: writer },
      worlds: { stripe: { world: "operational", tenant: stripe.tenant } },
      policies: [policy as BillingPolicyV2],
      newId: (p) => `${p}_${++n}`,
      retry: { maxAttempts: 1 },
      sleep: async () => {},
    };
    const job = {
      orgId: manifest.orgId,
      runId: "run_t114",
      planId: manifest.planId,
      revision: 1,
      planHash: hash,
    };
    return { run: () => executeRun(job, deps), journal, hash };
  }

  it("credits once and reads it back; a re-delivered job doesn't credit again", async () => {
    const s = setup(`plan_t114_${uniqueTenant("a")}`);
    const result = await s.run();
    expect(result.error).toBeNull();
    expect(result.state).toBe("completed");
    const [receipt] = result.receipts;
    expect(receipt?.outcome).toBe("confirmed");
    expect(receipt?.limitations).toContain("read back from the provider after the write");

    const [attempt] = await s.journal.attemptsFor(s.hash, "credit_001");
    const [credit, ...others] = await ours(attempt?.operationKey ?? "");
    expect(others).toEqual([]);
    expect(credit).toMatchObject({
      amount: -4210,
      currency: "cad",
      metadata: { charge: "ch_rehearsalT114cad1" },
    });
    expect(receipt?.providerRef).toEqual({
      vendor: "stripe",
      kind: "customer_balance_transaction",
      id: credit?.id,
    });

    expect((await s.run()).state).toBe("completed");
    expect(await ours(attempt?.operationKey ?? "")).toHaveLength(1);
  });

  it("reconciles a credit whose response was lost from the customer's transactions", async () => {
    const s = setup(`plan_t114_${uniqueTenant("b")}`, { loseFirstResponse: true });
    const first = await s.run();
    expect(first.receipts[0]?.outcome).toBe("unknown_outcome");
    const [attempt] = await s.journal.attemptsFor(s.hash, "credit_001");
    expect(await ours(attempt?.operationKey ?? "")).toHaveLength(1);

    const second = await s.run();
    const receipt = second.receipts.find((r) => r.actionId === "credit_001");
    expect(receipt?.outcome).toBe("confirmed");
    expect(receipt?.limitations.join(" ")).toContain("found by reading the provider; not re-sent");
    const found = await ours(attempt?.operationKey ?? "");
    expect(found).toHaveLength(1);
    expect(receipt?.providerRef?.id).toBe(found[0]?.id);
  });
});
