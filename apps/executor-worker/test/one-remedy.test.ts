import type { Observation, Receipt, ReplayBundle } from "@rehearsal/contracts";
import {
  BALANCE_CREDITS,
  type BillingPolicyV1,
  createReadGuard,
  type ExecutorDeps,
  executeRun,
  type ProviderPort,
  planHash,
  readRemedyHold,
} from "@rehearsal/core";
import {
  approvedGrant,
  FakeClock,
  fakeRunAdmit,
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
  store.grants.set(
    APPROVAL,
    approvedGrant({
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
    }),
  );
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
    admit: fakeRunAdmit({ now: () => clock.now() }),
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
      { manifest: s.manifest, confirmedReceipts: [confirmed], priorRemedies: [] },
    );
    expect(held).toMatchObject({
      kind: "policy_violation",
      rule: "R5.remedy_already_completed",
    });
    expect(s.world.refunds).toEqual([]);
  });
});

/** Revision 2 of the happy path: case 001's obligation re-targeted to the other charge of its pair. */
function retargeted(s: ReturnType<typeof setup>) {
  const manifest = structuredClone(s.manifest);
  manifest.revision = 2;
  manifest.parentRevision = 1;
  const charge = manifest.observations.find((item) => item.id === "obs_charge_001");
  const refund = manifest.actions.find((action) => action.id === "refund_001");
  if (!charge || refund?.kind !== "stripe.refund.create") throw new Error("no case 001 refund");
  manifest.observations.push({
    ...structuredClone(charge),
    id: "obs_charge_001b",
    entity: { vendor: "stripe", kind: "charge", id: "ch_fixture_001b" },
    projection: { ...charge.projection, id: "ch_fixture_001b" },
  });
  refund.evidence = ["obs_charge_001b"];
  // Revision 1's query of the customer's charges predates the second charge.
  refund.queryEvidence = [];
  refund.args.chargeId = "ch_fixture_001b";
  const hash = planHash(manifest);
  const store = s.deps.store as MemoryApplyStore;
  store.plans.set(`${manifest.planId}@2`, { planHash: hash, manifest });
  store.runs.set("run_2", {
    planId: manifest.planId,
    revision: 2,
    planHash: hash,
    approvalId: "grant_2",
  });
  const grant = store.grants.get(APPROVAL);
  if (!grant) throw new Error("no grant");
  store.grants.set("grant_2", { ...grant, id: "grant_2", revision: 2, planHash: hash });
  const original = structuredClone(s.world.charges.get("ch_fixture_001"));
  if (!original) throw new Error("no case 001 charge");
  // The other charge appears only now, so revision 1's evidence still matches when it runs.
  return () => {
    s.world.charges.set("ch_fixture_001b", { ...original, id: "ch_fixture_001b" });
    return executeRun(
      {
        orgId: manifest.orgId,
        runId: "run_2",
        planId: manifest.planId,
        revision: 2,
        planHash: hash,
      },
      s.deps,
    );
  };
}

/** The Stripe reader with one entity kind's projection replaced. */
function rewrite(
  base: ProviderPort,
  kind: string,
  change: (projection: Record<string, unknown>) => Record<string, unknown>,
): ProviderPort {
  return {
    ...base,
    observe: async (entity, world) => {
      const read = await base.observe(entity, world);
      return entity.kind === kind ? { ...read, projection: change(read.projection) } : read;
    },
  };
}

const step = {
  id: "refund_001",
  obligationId: "obl_overcharge_001",
  kind: "stripe.refund.create",
  chargeId: "ch_fixture_001",
  amountMinor: 4210,
  currency: "cad",
} as const;

describe("one remedy across retries, revisions and reads (T4.10 fixes)", () => {
  it("re-checks before replaying an unknown send and holds when a teammate credited meanwhile", async () => {
    const s = setup(happyPathBundle());
    s.world.fault("/v1/refunds", { kind: "server_error" });
    let credited = false;
    s.deps.sleep = async () => {
      if (credited) return;
      credited = true;
      s.world.teammateCredit({ customerId: "cus_fixture_001", amountMinor: 4210, currency: "cad" });
    };
    const result = await s.run();

    const receipt = result.receipts.find((item) => item.actionId === "refund_001");
    expect(receipt?.outcome).toBe("unknown_outcome");
    expect(receipt?.holdReason).toMatchObject({ rule: "R5.remedy_already_completed" });
    expect(receipt?.limitations.join(" ")).toMatch(/not re-sent/);
    expect(s.world.refunds.map((refund) => refund.charge)).toEqual(["ch_fixture_002"]);
  });

  it("still replays a send that landed, whatever changed during the backoff", async () => {
    const s = setup(happyPathBundle());
    s.world.fault("/v1/refunds", { kind: "drop_response_after_commit" });
    s.deps.sleep = async () => {
      s.world.teammateCredit({ customerId: "cus_fixture_001", amountMinor: 4210, currency: "cad" });
    };
    const result = await s.run();

    expect(outcomes(result.receipts).refund_001).toBe("confirmed");
    expect(s.world.refunds.filter((refund) => refund.charge === "ch_fixture_001")).toHaveLength(1);
  });

  it("holds a revision that refunds an obligation an earlier revision already refunded", async () => {
    const s = setup(happyPathBundle());
    const runRevision2 = retargeted(s);
    expect(outcomes((await s.run()).receipts).refund_001).toBe("confirmed");

    const result = await runRevision2();
    const receipt = result.receipts.find((item) => item.actionId === "refund_001");
    expect(receipt?.outcome).toBe("held");
    expect(receipt?.holdReason).toMatchObject({
      rule: "R5.remedy_already_completed",
      detail: expect.stringMatching(/already remedied by refund_001 under plan hash/),
    });
    expect(s.world.refunds.map((refund) => refund.charge).sort()).toEqual([
      "ch_fixture_001",
      "ch_fixture_002",
    ]);
  });

  it("holds a revision while an earlier revision's refund of the obligation is unknown", async () => {
    const s = setup(happyPathBundle());
    const runRevision2 = retargeted(s);
    s.world.fault("/v1/refunds", { kind: "server_error" });
    s.deps.retry = { maxAttempts: 1 };
    expect(outcomes((await s.run()).receipts).refund_001).toBe("unknown_outcome");

    const result = await runRevision2();
    const receipt = result.receipts.find((item) => item.actionId === "refund_001");
    expect(receipt?.holdReason).toMatchObject({
      rule: "R5.remedy_already_completed",
      detail: expect.stringMatching(/may already have remedied obligation obl_overcharge_001/),
    });
    expect(s.world.refunds.map((refund) => refund.charge)).toEqual(["ch_fixture_002"]);
  });

  it("holds a remedy when the store can't list other plans' remedies", async () => {
    const s = setup(happyPathBundle());
    Object.assign(s.deps.store, { remedyStepsFor: undefined });
    const result = await s.run();

    expect(
      result.receipts.find((item) => item.actionId === "refund_001")?.holdReason,
    ).toMatchObject({
      kind: "evidence_unavailable",
      detail: "other plans' remedies for this obligation could not be listed",
    });
    expect(s.world.refunds).toEqual([]);
  });

  it.each([
    ["an incomplete list", () => ({ complete: false, credits: [] }), /listed completely/],
    ["a list that is not an array", () => ({ complete: true, credits: {} }), /not a complete list/],
    [
      "a malformed credit",
      () => ({ complete: true, credits: [{ id: "cbtxn_1", amountMinor: 1.5, currency: "cad" }] }),
      /not a complete list/,
    ],
  ])("holds on %s of balance credits", async (_name, projection, detail) => {
    const s = setup(happyPathBundle());
    const stripe = rewrite(s.deps.providers.stripe as ProviderPort, BALANCE_CREDITS, projection);
    const held = await readRemedyHold(
      { providers: { stripe }, worlds: s.deps.worlds, clock: s.deps.clock },
      step,
      { manifest: s.manifest, confirmedReceipts: [], priorRemedies: [] },
    );
    expect(held).toMatchObject({
      kind: "evidence_unavailable",
      detail: expect.stringMatching(detail),
    });
  });

  it("holds when the charge re-read names no customer or no refunded amount", async () => {
    const s = setup(happyPathBundle());
    const context = { manifest: s.manifest, confirmedReceipts: [], priorRemedies: [] };
    const drop = (field: string) => (projection: Record<string, unknown>) => {
      const { [field]: _dropped, ...rest } = projection;
      return rest;
    };
    for (const [field, detail] of [
      ["customer", /no customer/],
      ["amount_refunded", /no refunded amount/],
    ] as const) {
      const stripe = rewrite(s.deps.providers.stripe as ProviderPort, "charge", drop(field));
      const held = await readRemedyHold(
        { providers: { stripe }, worlds: s.deps.worlds, clock: s.deps.clock },
        step,
        context,
      );
      expect(held).toMatchObject({
        kind: "evidence_unavailable",
        detail: expect.stringMatching(detail),
      });
    }
  });

  it("holds a refund the evidence doesn't explain, and passes one it does", async () => {
    const s = setup(happyPathBundle());
    const charge = s.world.charges.get("ch_fixture_001");
    if (!charge) throw new Error("no case 001 charge");
    const deps = { providers: s.deps.providers, worlds: s.deps.worlds, clock: s.deps.clock };
    const context = { manifest: s.manifest, confirmedReceipts: [], priorRemedies: [] };

    charge.amount_refunded = 100;
    expect(await readRemedyHold(deps, step, context)).toMatchObject({
      detail: "charge ch_fixture_001 already has a refund",
    });

    // The approved evidence already showed that 100, so it is not a new remedy.
    const evidenced = structuredClone(s.manifest);
    const observed = evidenced.observations.find((item) => item.id === "obs_charge_001");
    if (!observed) throw new Error("no case 001 evidence");
    observed.projection = { ...observed.projection, amount_refunded: 100 };
    expect(await readRemedyHold(deps, step, { ...context, manifest: evidenced })).toBeNull();
  });
});
