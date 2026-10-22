import type { ReplayBundle } from "@rehearsal/contracts";
import {
  type BillingPolicyV1,
  createReadGuard,
  type ExecutorDeps,
  executeRun,
  type ProviderPort,
  planHash,
} from "@rehearsal/core";
import {
  type FakeCharge,
  FakeClock,
  type FakeWorld,
  happyPathBundle,
  MemoryApplyStore,
  MemoryJournal,
  phantomBundle,
  worldFromManifest,
} from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import policy from "../../../scenarios/billing/policy.v1.json" with { type: "json" };

const RUN = "run_1";
const APPROVAL = "grant_1";

/** One approved bundle on an identical fake operational world, with the read guard installed. */
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
  const job = {
    orgId: manifest.orgId,
    runId: RUN,
    planId: manifest.planId,
    revision: 1,
    planHash: hash,
  };
  return { world, providers, run: () => executeRun(job, deps) };
}

/** Apply the bundle's `before_apply` record injections to the fake operational world. */
function injectBeforeApply(world: FakeWorld, bundle: ReplayBundle) {
  for (const p of bundle.perturbations) {
    if (p.kind !== "inject_records" || p.at !== "before_apply" || p.world !== "operational") {
      continue;
    }
    for (const charge of p.records.charges ?? []) {
      const c = charge as unknown as FakeCharge;
      world.charges.set(c.id, c);
    }
  }
}

const outcomes = (receipts: { actionId: string; outcome: string }[]) =>
  Object.fromEntries(receipts.map((r) => [r.actionId, r.outcome]));

describe("read guard in the executor", () => {
  it("admits the happy path, including the note after the case's own priority patch", async () => {
    const bundle = happyPathBundle();
    const s = setup(bundle);
    const result = await s.run();
    expect(result.state).toBe("completed");
    expect(outcomes(result.receipts)).toEqual(
      Object.fromEntries(bundle.expected.map((e) => [e.actionId, e.outcome])),
    );
    expect(s.world.tickets.get("5531")?.comments).toHaveLength(1);
  });

  it("phantom: holds case 001's refund on the new charge, skips its note, applies case 002", async () => {
    const bundle = phantomBundle();
    const s = setup(bundle);
    injectBeforeApply(s.world, bundle);
    const result = await s.run();

    expect(outcomes(result.receipts)).toEqual(
      Object.fromEntries(bundle.expected.map((e) => [e.actionId, e.outcome])),
    );
    expect(result.receipts.find((r) => r.actionId === "refund_001")?.holdReason).toEqual({
      kind: "query_membership_changed",
      queryObservationId: "q_charges_001",
      added: ["ch_fixture_001_dup"],
      removed: [],
    });
    expect(s.world.refunds.map((r) => r.charge)).toEqual(["ch_fixture_002"]);
    expect(result.state).toBe("partial");
  });

  it("holds a ticket step when a teammate changed a planned field before apply", async () => {
    const s = setup(happyPathBundle());
    const ticket = s.world.tickets.get("5532");
    if (ticket) ticket.priority = "urgent";
    const result = await s.run();

    expect(outcomes(result.receipts)).toMatchObject({
      refund_002: "confirmed",
      patch_002: "held",
      note_002: "held",
    });
    expect(result.receipts.find((r) => r.actionId === "patch_002")?.holdReason).toEqual({
      kind: "row_changed",
      observationId: "obs_ticket_002",
      fields: ["priority"],
    });
    expect(s.world.tickets.get("5532")?.priority).toBe("urgent");
  });

  it("holds when a re-read fails instead of treating it as unchanged", async () => {
    const s = setup(happyPathBundle());
    s.providers.stripe.query = async () => {
      throw new Error("503 from stripe");
    };
    const result = await s.run();

    expect(outcomes(result.receipts)).toMatchObject({
      refund_001: "held",
      note_001: "skipped_dependency",
      refund_002: "held",
    });
    expect(result.receipts.find((r) => r.actionId === "refund_001")?.holdReason).toEqual({
      kind: "evidence_unavailable",
      evidenceId: "q_charges_001",
      detail: "re-read failed: 503 from stripe",
    });
    expect(s.world.refunds).toEqual([]);
  });
});
