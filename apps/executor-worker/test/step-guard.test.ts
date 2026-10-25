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
  /** Store revision 2 (an identical copy) with its own run and grant, like a re-approval. */
  const addRevision = () => {
    const rev2 = structuredClone({ ...manifest, revision: 2, parentRevision: 1 });
    const hash2 = planHash(rev2);
    store.plans.set(`${manifest.planId}@2`, { planHash: hash2, manifest: rev2 });
    store.runs.set("run_2", {
      planId: manifest.planId,
      revision: 2,
      planHash: hash2,
      approvalId: "grant_2",
    });
    const grant = store.grants.get(APPROVAL);
    if (!grant) throw new Error("setup has no grant");
    store.grants.set("grant_2", { ...grant, id: "grant_2", revision: 2, planHash: hash2 });
    const job2 = { ...job, runId: "run_2", revision: 2, planHash: hash2 };
    return () => executeRun(job2, deps);
  };
  return { world, providers, deps, addRevision, run: () => executeRun(job, deps) };
}

/** The happy path, with each note also citing its case's charge (read again after the refund). */
function noteReadsCharge(): ReplayBundle {
  const bundle = happyPathBundle();
  for (const action of bundle.manifest.actions) {
    if (action.kind === "zendesk.ticket.appendPrivateNote") {
      action.evidence.push(action.id.replace("note_", "obs_charge_"));
    }
  }
  return bundle;
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
  it("preserves an edit made while capturing the provider precondition", async () => {
    const s = setup(happyPathBundle());
    const preconditions = s.providers.zendesk.preconditions;
    s.providers.zendesk.preconditions = async (action, ctx) => {
      if (action.kind === "zendesk.ticket.patchFields" && action.args.ticketId === "5531") {
        s.world.teammateEdit("5531", "priority", "urgent");
      }
      return preconditions?.(action, ctx) ?? {};
    };
    const result = await s.run();
    expect(result.receipts.find((r) => r.actionId === "patch_001")).toMatchObject({
      outcome: "held",
      holdReason: { kind: "row_changed", fields: ["priority"] },
    });
    expect(s.world.tickets.get("5531")?.priority).toBe("urgent");
  });

  it("holds a phantom introduced during a definite 429 backoff", async () => {
    const s = setup(happyPathBundle());
    s.world.fault("/v1/refunds", { kind: "reject", status: 429, retryable: true, retryAfterMs: 1 });
    s.deps.sleep = async () => {
      const charge = s.world.charges.get("ch_fixture_001");
      if (!charge) throw new Error("missing charge");
      s.world.charges.set("ch_retry_phantom", { ...charge, id: "ch_retry_phantom" });
    };
    const out = await s.run();
    expect(out.receipts.find((r) => r.actionId === "refund_001")).toMatchObject({
      outcome: "held",
      holdReason: { kind: "query_membership_changed", added: ["ch_retry_phantom"] },
    });
    expect(out.receipts.find((r) => r.actionId === "note_001")?.outcome).toBe("skipped_dependency");
    expect(s.world.refunds.filter((r) => r.charge === "ch_fixture_001")).toHaveLength(0);
  });

  it("still resolves an unknown refund through identical idempotent replay", async () => {
    const s = setup(happyPathBundle());
    s.world.fault("/v1/refunds", { kind: "drop_response_after_commit" });
    s.deps.sleep = async () => {};
    expect((await s.run()).state).toBe("completed");
    expect(s.world.refunds.filter((r) => r.charge === "ch_fixture_001")).toHaveLength(1);
  });
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

  it("holds the priority patch but records the refund after a teammate's priority edit", async () => {
    const s = setup(happyPathBundle());
    const ticket = s.world.tickets.get("5532");
    if (ticket) ticket.priority = "urgent";
    const result = await s.run();

    expect(outcomes(result.receipts)).toMatchObject({
      refund_002: "confirmed",
      patch_002: "held",
      note_002: "confirmed",
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

  it("holds an incomplete query enumeration instead of treating it as no new charges", async () => {
    const s = setup(happyPathBundle());
    const query = s.providers.stripe.query;
    s.providers.stripe.query = async (...args) => ({ ...(await query(...args)), complete: false });
    const result = await s.run();

    expect(result.receipts.find((r) => r.actionId === "refund_001")?.holdReason).toEqual({
      kind: "evidence_unavailable",
      evidenceId: "q_charges_001",
      detail: "current query enumeration is incomplete",
    });
    expect(s.world.refunds).toEqual([]);
  });

  it("a later read of a charge we just refunded admits on our own refund", async () => {
    const s = setup(noteReadsCharge());
    const result = await s.run();
    expect(result.state).toBe("completed");
    expect(s.world.charges.get("ch_fixture_001")?.amount_refunded).toBe(4210);
  });

  it("a refund adopted by a re-approved revision is credited once, not twice", async () => {
    const s = setup(noteReadsCharge());
    const readGuard = s.deps.guard;
    s.deps.guard = async (action, ctx) =>
      action.id === "note_001"
        ? { kind: "approval_invalid", detail: "held for the test" }
        : (readGuard?.(action, ctx) ?? null);
    const first = await s.run();
    expect(outcomes(first.receipts)).toMatchObject({ refund_001: "confirmed", note_001: "held" });

    s.deps.guard = readGuard;
    const second = await s.addRevision()();
    expect(outcomes(second.receipts)).toMatchObject({
      refund_001: "confirmed",
      note_001: "confirmed",
    });
    expect(s.world.refunds.filter((r) => r.charge === "ch_fixture_001")).toHaveLength(1);
  });

  it("two planned snapshots of one ticket are read once and admit", async () => {
    const bundle = happyPathBundle();
    const ticket = bundle.manifest.observations.find((o) => o.id === "obs_ticket_001");
    if (!ticket) throw new Error("fixture has no obs_ticket_001");
    bundle.manifest.observations.push({ ...ticket, id: "obs_ticket_001_again" });
    const note = bundle.manifest.actions.find((a) => a.id === "note_001");
    note?.evidence.push("obs_ticket_001_again");
    const s = setup(bundle);
    const result = await s.run();
    expect(result.state).toBe("completed");
  });

  it("a charge created outside the incident window does not trip the phantom hold", async () => {
    const s = setup(happyPathBundle());
    s.world.charges.set("ch_fixture_001_october", {
      id: "ch_fixture_001_october",
      customer: "cus_fixture_001",
      amount: 4210,
      amount_refunded: 0,
      currency: "cad",
      status: "succeeded",
      created: 1_791_590_400, // 2026-10-10T00:00Z, after the September window
    });
    const result = await s.run();
    expect(result.state).toBe("completed");
  });
});
