import type { Action, ApprovalGrant, PlanManifest } from "@rehearsal/contracts";
import {
  type BillingPolicy,
  createReadGuard,
  type ExecutorDeps,
  executeRun,
  fingerprint,
  planHash,
} from "@rehearsal/core";
import {
  approvedGrant,
  billingManifest,
  FakeClock,
  fakeRunAdmit,
  MemoryApplyStore,
  MemoryJournal,
  worldFromManifest,
} from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import policyV1 from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import policyV2 from "../../../scenarios/billing/policy.v2.json" with { type: "json" };

const CUSTOMER = "cus_fixture_001";
const CHARGE = "ch_fixture_001";
const CREDITS = `/v1/customers/${CUSTOMER}/balance_transactions`;

/** The fixture plan with case 001 settled by an invoice-balance credit instead of a refund (T1.14). */
function creditPlan(planId: string): PlanManifest {
  const manifest = billingManifest(planId);
  const customer = { id: CUSTOMER, currency: null };
  const credit: Action = {
    id: "credit_001",
    kind: "stripe.customer.balanceCredit",
    caseId: "case_001",
    obligationId: "obl_overcharge_001",
    dependsOn: [],
    requiredRole: "support_lead",
    evidence: ["obs_charge_001", "obs_customer_001"],
    queryEvidence: ["q_charges_001"],
    compensation: "compensable_by_new_action",
    protection: "native_guard_with_documented_limits",
    rationale: "Small duplicate; credit the invoice balance.",
    args: {
      customerId: CUSTOMER,
      chargeId: CHARGE,
      amount: { amountMinor: 4210, currency: "cad" },
    },
  };
  return {
    ...manifest,
    policies: [{ id: "billing-remedy", version: 2 }],
    observations: [
      ...manifest.observations,
      {
        id: "obs_customer_001",
        world: "planning",
        entity: { vendor: "stripe", kind: "customer", id: CUSTOMER },
        projectionVersion: "stripe.customer.v1",
        projection: customer,
        fingerprint: fingerprint(customer),
        capturedAt: "2026-10-21T10:00:00.000Z",
      },
    ],
    // The refund-confirmed note binds a refund ID, so a credited case has none.
    actions: [
      credit,
      ...manifest.actions.filter((a) => a.id !== "refund_001" && a.id !== "note_001"),
    ],
  };
}

/** One org, one store and one operational world; each plan gets its own approved run. */
function setup(first: PlanManifest) {
  const store = new MemoryApplyStore();
  const journal = new MemoryJournal();
  const world = worldFromManifest(first.observations);
  const clock = new FakeClock("2026-10-21T12:00:00.000Z");
  let n = 0;
  const deps: ExecutorDeps = {
    store,
    journal,
    clock,
    providers: { stripe: world.provider("stripe"), zendesk: world.provider("zendesk") },
    worlds: {
      stripe: { world: "operational", tenant: "test" },
      zendesk: { world: "operational", tenant: "test" },
    },
    policies: [policyV1, policyV2] as BillingPolicy[],
    admit: fakeRunAdmit({ now: () => clock.now() }),
    newId: (prefix: string) => `${prefix}_${++n}`,
    sleep: async () => {},
  };
  deps.guard = createReadGuard({
    providers: deps.providers,
    worlds: deps.worlds,
    clock: deps.clock,
  });
  const approve = (manifest: PlanManifest) => {
    const { planId, revision } = manifest;
    const hash = planHash(manifest);
    const runId = `run_${planId}@${revision}`;
    const approvalId = `grant_${planId}@${revision}`;
    store.plans.set(`${planId}@${revision}`, { planHash: hash, manifest });
    store.runs.set(runId, { planId, revision, planHash: hash, approvalId });
    const grant: ApprovalGrant = approvedGrant({
      id: approvalId,
      orgId: manifest.orgId,
      planId,
      revision,
      planHash: hash,
      actorUserId: "user_finance",
      actorSessionId: "sess_1",
      roles: ["support_lead", "finance_lead"],
      grantedAt: "2026-10-21T11:00:00.000Z",
      expiresAt: "2026-10-21T13:00:00.000Z",
      revokedAt: null,
    });
    store.grants.set(approvalId, grant);
    const job = { orgId: manifest.orgId, runId, planId, revision, planHash: hash };
    return () => executeRun(job, deps);
  };
  return { world, deps, approve };
}

const outcomeOf = (receipts: { actionId: string; outcome: string }[], id: string) =>
  receipts.find((r) => r.actionId === id)?.outcome;

describe("balance credit (T1.14)", () => {
  it("credits the customer once, reads it back, and the receipt names the balance transaction", async () => {
    const plan = creditPlan("plan_credit");
    const s = setup(plan);
    const out = await s.approve(plan)();
    expect(out.state).toBe("completed");
    expect(s.world.credits).toEqual([
      expect.objectContaining({
        customerId: CUSTOMER,
        amountMinor: 4210,
        currency: "cad",
        chargeId: CHARGE,
      }),
    ]);
    // The charge itself is untouched: the remedy stays on the customer's account.
    expect(s.world.refunds.filter((r) => r.charge === CHARGE)).toHaveLength(0);
    const receipt = out.receipts.find((r) => r.actionId === "credit_001");
    expect(receipt?.outcome).toBe("confirmed");
    expect(receipt?.providerRef).toEqual({
      vendor: "stripe",
      kind: "customer_balance_transaction",
      id: s.world.credits[0]?.id,
    });
    expect(receipt?.limitations).toContain("read back from the provider after the write");
  });

  it("finds a lost credit by reading the customer's transactions instead of crediting twice", async () => {
    const plan = creditPlan("plan_credit");
    const s = setup(plan);
    s.deps.retry = { maxAttempts: 1 };
    s.world.fault(CREDITS, { kind: "drop_response_after_commit" });
    const run = s.approve(plan);
    expect(outcomeOf((await run()).receipts, "credit_001")).toBe("unknown_outcome");
    expect(s.world.credits).toHaveLength(1);

    const second = await run();
    const receipt = second.receipts.find((r) => r.actionId === "credit_001");
    expect(receipt?.outcome).toBe("confirmed");
    expect(receipt?.limitations.join(" ")).toContain("found by reading the provider; not re-sent");
    expect(s.world.credits).toHaveLength(1);
    expect(receipt?.providerRef?.id).toBe(s.world.credits[0]?.id);
  });

  it("adopts a credit confirmed under an earlier revision with its balance transaction, not re-sent", async () => {
    const plan = creditPlan("plan_credit");
    const s = setup(plan);
    const first = (await s.approve(plan)()).receipts.find((r) => r.actionId === "credit_001");
    expect(first?.outcome).toBe("confirmed");

    // Re-approved as revision 2 with the credit unchanged, as after excluding another customer.
    const rev2: PlanManifest = { ...plan, revision: 2, parentRevision: 1 };
    expect(planHash(rev2)).not.toBe(planHash(plan));
    const out = await s.approve(rev2)();
    expect(out.state).toBe("completed");
    const adopted = out.receipts.find((r) => r.actionId === "credit_001");
    expect(adopted?.outcome).toBe("confirmed");
    expect(adopted?.providerRef).toEqual({
      vendor: "stripe",
      kind: "customer_balance_transaction",
      id: s.world.credits[0]?.id,
    });
    expect(adopted?.observedEffect).toEqual(first?.observedEffect);
    expect(adopted?.observedEffect).toMatchObject({
      "credit.id": s.world.credits[0]?.id,
      "credit.amount": -4210,
      "credit.charge": CHARGE,
      currency: "cad",
    });
    expect(adopted?.limitations.join(" ")).toContain("not re-sent");
    expect(s.world.credits).toHaveLength(1);
  });

  it("holds a credit when the customer's currency no longer matches what was approved", async () => {
    const plan = creditPlan("plan_credit");
    const s = setup(plan);
    s.world.customerCurrencies.set(CUSTOMER, "usd");
    const out = await s.approve(plan)();
    const receipt = out.receipts.find((r) => r.actionId === "credit_001");
    expect(receipt?.outcome).toBe("held");
    // Era would take it (surprise 14); the writer's precondition read refuses before any send.
    expect(receipt?.holdReason).toMatchObject({
      detail: expect.stringContaining(`customer ${CUSTOMER} is in usd, the credit is in cad`),
    });
    expect(s.world.credits).toHaveLength(0);
  });

  it("holds a credit for a charge someone refunded after approval", async () => {
    const plan = creditPlan("plan_credit");
    const s = setup(plan);
    const charge = s.world.charges.get(CHARGE);
    if (!charge) throw new Error("no fixture charge");
    charge.amount_refunded = 4210;
    const out = await s.approve(plan)();
    expect(out.receipts.find((r) => r.actionId === "credit_001")?.holdReason).toMatchObject({
      kind: "row_changed",
      fields: ["amount_refunded"],
    });
    expect(s.world.credits).toHaveLength(0);
  });

  it("holds a credit when another plan already refunded the same obligation", async () => {
    const refundPlan = billingManifest("plan_refund");
    const s = setup(refundPlan);
    const first = await s.approve(refundPlan)();
    expect(outcomeOf(first.receipts, "refund_001")).toBe("confirmed");

    // A second plan approved on evidence read after that refund, so nothing it cites has drifted:
    // only the one-remedy check across plans stands between it and a second remedy.
    const fresh = creditPlan("plan_credit");
    const plan: PlanManifest = {
      ...fresh,
      observations: fresh.observations.map((o) => {
        if (o.id !== "obs_charge_001") return o;
        const projection = { ...o.projection, amount_refunded: 4210 };
        return { ...o, projection, fingerprint: fingerprint(projection) };
      }),
    };
    const out = await s.approve(plan)();
    const receipt = out.receipts.find((r) => r.actionId === "credit_001");
    expect(receipt?.outcome).toBe("held");
    expect(JSON.stringify(receipt?.holdReason)).toContain(
      "obligation obl_overcharge_001 was already remedied by refund_001",
    );
    expect(s.world.credits).toHaveLength(0);
  });
});
