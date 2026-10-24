import type { Observation, Receipt, ReplayBundle } from "@rehearsal/contracts";
import {
  type BillingPolicyV1,
  createReadGuard,
  type ExecutorDeps,
  executeRun,
  type ProviderPort,
  planHash,
  readRemedyHold,
} from "@rehearsal/core";
import {
  FakeClock,
  happyPathBundle,
  MemoryApplyStore,
  MemoryJournal,
  worldFromManifest,
} from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import policy from "../../../scenarios/billing/policy.v1.json" with { type: "json" };

const RUN = "run_1";
const APPROVAL = "grant_1";

function setup(bundle: ReplayBundle) {
  const { manifest } = bundle;
  const hash = planHash(manifest);
  const clock = new FakeClock("2026-10-21T12:00:00.000Z");
  const store = new MemoryApplyStore();
  store.runs.set(RUN, {
    planId: manifest.planId,
    revision: 1,
    planHash: hash,
    approvalId: APPROVAL,
  });
  store.plans.set(`${manifest.planId}@1`, { planHash: hash, manifest });
  store.grants.set(APPROVAL, {
    id: APPROVAL,
    orgId: manifest.orgId,
    planId: manifest.planId,
    revision: 1,
    planHash: hash,
    actorUserId: "user_finance",
    actorSessionId: "sess_1",
    roles: ["support_lead", "finance_lead"],
    grantedAt: "2026-10-21T11:00:00.000Z",
    expiresAt: "2026-10-21T13:00:00.000Z",
    revokedAt: null,
  });
  const world = worldFromManifest(manifest.observations);
  const providers: Record<"stripe" | "zendesk", ProviderPort> = {
    stripe: world.provider("stripe"),
    zendesk: world.provider("zendesk"),
  };
  const worlds = {
    stripe: { world: "operational", tenant: "test" },
    zendesk: { world: "operational", tenant: "test" },
  } as const;
  let n = 0;
  const deps: ExecutorDeps = {
    store,
    journal: new MemoryJournal(),
    clock,
    providers,
    worlds,
    policies: [policy as BillingPolicyV1],
    newId: (prefix: string) => `${prefix}_${++n}`,
    guard: createReadGuard({ providers, worlds, clock }),
  };
  return {
    world,
    manifest,
    deps,
    run: () =>
      executeRun(
        { orgId: manifest.orgId, runId: RUN, planId: manifest.planId, revision: 1, planHash: hash },
        deps,
      ),
  };
}

const outcomes = (receipts: { actionId: string; outcome: string }[]) =>
  Object.fromEntries(receipts.map((receipt) => [receipt.actionId, receipt.outcome]));

/** A second refund of case 001's obligation, against a charge that is still unrefunded. */
function secondCharge(bundle: ReplayBundle): ReplayBundle {
  const { manifest } = bundle;
  const refund = manifest.actions.find((action) => action.id === "refund_001");
  const charge = manifest.observations.find((item) => item.id === "obs_charge_001");
  if (refund?.kind !== "stripe.refund.create" || !charge) throw new Error("no case 001 refund");
  const other: Observation = {
    ...structuredClone(charge),
    id: "obs_charge_001b",
    entity: { vendor: "stripe", kind: "charge", id: "ch_fixture_001b" },
    projection: { ...charge.projection, id: "ch_fixture_001b" },
  };
  manifest.observations.push(other);
  manifest.actions.push({
    ...structuredClone(refund),
    id: "refund_001b",
    evidence: ["obs_charge_001b"],
    args: { ...refund.args, chargeId: "ch_fixture_001b" },
  });
  return bundle;
}

describe("one remedy per obligation", () => {
  it("holds the refund a teammate already credited and still refunds the other customer", async () => {
    const bundle = happyPathBundle();
    const s = setup(bundle);
    s.world.teammateCredit({
      customerId: "cus_fixture_001",
      amountMinor: 4210,
      currency: "cad",
      chargeId: "ch_fixture_001",
    });
    const result = await s.run();

    expect(outcomes(result.receipts)).toMatchObject({
      refund_001: "held",
      note_001: "skipped_dependency",
      refund_002: "confirmed",
    });
    expect(
      result.receipts.find((receipt) => receipt.actionId === "refund_001")?.holdReason,
    ).toMatchObject({
      kind: "policy_violation",
      rule: "R5.remedy_already_completed",
    });
    expect(s.world.refunds.map((refund) => refund.charge)).toEqual(["ch_fixture_002"]);
  });

  it("does not treat a credit for a different charge and amount as this remedy", async () => {
    const bundle = happyPathBundle();
    const s = setup(bundle);
    s.world.teammateCredit({
      customerId: "cus_fixture_001",
      amountMinor: 100,
      currency: "cad",
      chargeId: "ch_other",
    });
    const result = await s.run();

    expect(outcomes(result.receipts).refund_001).toBe("confirmed");
    expect(outcomes(result.receipts).refund_002).toBe("confirmed");
  });

  it("holds a later refund of an obligation this plan already remedied", async () => {
    // R2 refuses a plan that already contains both refunds, so this calls the step guard
    // with the first refund confirmed rather than admitting the plan again.
    const bundle = secondCharge(happyPathBundle());
    const s = setup(bundle);
    const confirmed: Receipt = {
      id: "rcp_1",
      actionId: "refund_001",
      planHash: "a".repeat(64),
      approvalId: APPROVAL,
      outcome: "confirmed",
      providerRef: { vendor: "stripe", kind: "refund", id: "re_1" },
      observedEffect: {},
      protection: "native_guard_with_documented_limits",
      holdReason: null,
      limitations: [],
      recordedAt: "2026-10-21T12:00:00.000Z",
    };
    const held = await readRemedyHold(
      s.deps,
      {
        id: "refund_001b",
        obligationId: "obl_overcharge_001",
        kind: "stripe.refund.create",
        chargeId: "ch_fixture_001b",
        amountMinor: 4210,
        currency: "cad",
      },
      s.manifest,
      [confirmed],
    );
    expect(held).toMatchObject({
      kind: "policy_violation",
      rule: "R5.remedy_already_completed",
    });
    expect(s.world.refunds).toEqual([]);
  });
});
