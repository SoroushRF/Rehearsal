import { ExecutionRehearsalReport } from "@rehearsal/contracts";
import {
  type BillingPolicy,
  createCompensator,
  type ExecutorDeps,
  executeRehearsal,
  executeRun,
  type ProviderPort,
  planHash,
  type RegistrySnapshot,
  type RehearsalExecutorDeps,
  reconcileRehearsal,
  rehearsalJournalHash,
  rehearsalTenant,
  VERIFIER_VERSION,
} from "@rehearsal/core";
import { IN_FLIGHT_KEPT, rehearsalReport } from "@rehearsal/db";
import {
  approvedGrant,
  FakeClock,
  FIXTURE_REHEARSAL_VERSIONS,
  fakeRunAdmit,
  happyPathBundle,
  MemoryApplyStore,
  MemoryJournal,
  rehearsalJobFixture,
  worldFromManifest,
} from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import policy from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import policyV3 from "../../../scenarios/billing/policy.v3.json" with { type: "json" };

const POLICIES = [policy, policyV3] as unknown as BillingPolicy[];
const RID = "rh0test0001";
const RUN = "run_1";
const APPROVAL = "grant_1";

/** One stored plan, with both an operational run+grant and a rehearsal of it available. */
function setup() {
  const { manifest } = happyPathBundle();
  const hash = planHash(manifest);
  const store = new MemoryApplyStore();
  store.plans.set(`${manifest.planId}@1`, { planHash: hash, manifest });
  store.runs.set(RUN, {
    planId: manifest.planId,
    revision: 1,
    planHash: hash,
    approvalId: APPROVAL,
  });
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
  const clock = new FakeClock("2026-10-21T12:00:00.000Z");
  let n = 0;
  const newId = (prefix: string) => `${prefix}_${++n}`;
  const cancelled = new Set<string>();
  /** A fresh disposable world per mode: a rehearsal never shares one with operation. */
  const rehearsal = (
    journal = new MemoryJournal(),
    world = worldFromManifest(manifest.observations),
  ) => {
    const tenant = rehearsalTenant(RID);
    const deps: RehearsalExecutorDeps & { providers: Record<"stripe" | "zendesk", ProviderPort> } =
      {
        plans: {
          loadPlan: (orgId, planId, revision) => store.loadPlan(orgId, planId, revision),
          rehearsalCancelled: async (_orgId, id) => cancelled.has(id),
        },
        journal,
        clock,
        providers: { stripe: world.provider("stripe"), zendesk: world.provider("zendesk") },
        worlds: {
          stripe: { world: "rehearsal", tenant },
          zendesk: { world: "rehearsal", tenant },
        },
        policies: POLICIES,
        newId,
        sleep: async () => {},
      };
    const job = {
      orgId: manifest.orgId,
      rehearsalId: RID,
      planId: manifest.planId,
      revision: 1,
      planHash: hash,
    };
    return { deps, world, journal, run: () => executeRehearsal(job, deps) };
  };
  const operational = (
    journal = new MemoryJournal(),
    world = worldFromManifest(manifest.observations),
  ) => {
    const deps: ExecutorDeps & { providers: Record<"stripe" | "zendesk", ProviderPort> } = {
      store,
      journal,
      clock,
      providers: { stripe: world.provider("stripe"), zendesk: world.provider("zendesk") },
      worlds: {
        stripe: { world: "operational", tenant: "test" },
        zendesk: { world: "operational", tenant: "test" },
      },
      policies: POLICIES,
      admit: fakeRunAdmit({ now: () => clock.now() }),
      newId,
      sleep: async () => {},
    };
    const job = {
      orgId: manifest.orgId,
      runId: RUN,
      planId: manifest.planId,
      revision: 1,
      planHash: hash,
    };
    return { deps, world, journal, run: () => executeRun(job, deps) };
  };
  return { manifest, hash, store, cancelled, rehearsal, operational };
}

const outcomes = (receipts: { actionId: string; outcome: string }[]) =>
  Object.fromEntries(receipts.map((r) => [r.actionId, r.outcome]));

describe("shared execution mechanics, separate admission (T3.14)", () => {
  it("rehearses the stored plan with no grant, journaling every key under the rehearsal", async () => {
    const s = setup();
    s.store.grants.clear(); // a rehearsal needs no grant at all
    const r = s.rehearsal();
    const result = await r.run();
    expect(result.state).toBe("completed");
    expect(new Set(Object.values(outcomes(result.receipts)))).toEqual(new Set(["confirmed"]));
    const keys = [...r.journal.attempts.values()].map((a) => a.operationKey);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.startsWith(`rh_${RID}_op_`))).toBe(true);
    expect(result.receipts.every((x) => x.approvalId === `rehearsal:${RID}`)).toBe(true);
    // Filed under a namespaced hash: nothing keyed by the real plan hash sees them.
    expect(await r.journal.receiptsFor(s.hash)).toEqual([]);
    expect(await r.journal.bindings(s.hash)).toEqual([]);
    expect(result.receipts.every((x) => x.planHash === rehearsalJournalHash(RID, s.hash))).toBe(
      true,
    );
    // Read-back and result bindings work the same: the note carries the refund it depends on.
    expect(result.receipts.find((x) => x.actionId === "refund_001")?.limitations).toEqual([
      "read back from the provider after the write",
    ]);
    expect(r.world.refunds).toHaveLength(2);
    expect(r.world.tickets.get("5531")?.comments[0]?.body).toContain(r.world.refunds[0]?.id);
  });

  it("refuses a rehearsal configured for an operational world, or another rehearsal's tenant", async () => {
    const s = setup();
    for (const ctx of [
      { world: "operational" as const, tenant: "test" },
      { world: "rehearsal" as const, tenant: rehearsalTenant("someoneelse1") },
    ]) {
      const r = s.rehearsal();
      r.deps.worlds = { ...r.deps.worlds, stripe: ctx };
      const result = await r.run();
      expect(result.refusal).toMatch(/not this rehearsal's/);
      expect(r.world.effects).toEqual([]);
      expect(r.journal.attempts.size).toBe(0);
    }
  });

  it("refuses a rehearsal of a changed hash or a plan its policy wouldn't approve", async () => {
    const s = setup();
    const changed = s.rehearsal();
    const stored = s.store.plans.get(`${s.manifest.planId}@1`);
    if (!stored) throw new Error("no plan");
    s.store.plans.set(`${s.manifest.planId}@1`, { ...stored, planHash: "f".repeat(64) });
    expect((await changed.run()).refusal).toMatch(/stored hash differs/);
    s.store.plans.set(`${s.manifest.planId}@1`, stored);
    const unloaded = s.rehearsal();
    unloaded.deps.policies = [];
    expect((await unloaded.run()).refusal).toMatch(/is not loaded/);
    expect(unloaded.world.effects).toEqual([]);
  });

  it("keeps operational admission closed to rehearsal worlds and to a missing, revoked or expired grant", async () => {
    const s = setup();
    const toRehearsal = s.operational();
    toRehearsal.deps.worlds = {
      stripe: { world: "rehearsal", tenant: rehearsalTenant(RID) },
      zendesk: { world: "rehearsal", tenant: rehearsalTenant(RID) },
    };
    expect((await toRehearsal.run()).refusal).toMatch(/configured for the rehearsal world/);
    expect(toRehearsal.world.effects).toEqual([]);

    const grant = s.store.grants.get(APPROVAL);
    if (!grant) throw new Error("no grant");
    for (const [change, why] of [
      [() => s.store.grants.delete(APPROVAL), /grant not found/],
      [
        () => s.store.grants.set(APPROVAL, { ...grant, revokedAt: "2026-10-21T11:30:00.000Z" }),
        /revoked/,
      ],
      [
        () => s.store.grants.set(APPROVAL, { ...grant, expiresAt: "2026-10-21T11:59:00.000Z" }),
        /expired/,
      ],
    ] as const) {
      s.store.grants.set(APPROVAL, grant);
      change();
      const o = s.operational();
      expect((await o.run()).refusal).toMatch(why);
      expect(o.world.effects).toEqual([]);
    }
  });

  it("never lets one mode adopt the other's history, even through one journal", async () => {
    const s = setup();
    const shared = new MemoryJournal();
    // A rehearsal confirms every step in its disposable world...
    const r = s.rehearsal(shared);
    expect((await r.run()).state).toBe("completed");
    // ...and the operational run over the same journal still sends its own writes.
    const o = s.operational(shared);
    const real = await o.run();
    expect(real.state).toBe("completed");
    expect(o.world.refunds).toHaveLength(2);
    for (const receipt of real.receipts) {
      expect(receipt.limitations.join(" ")).not.toMatch(/not re-sent/);
      expect(receipt.approvalId).toBe(APPROVAL);
    }

    // The other way round: an operational history doesn't satisfy a rehearsal either.
    const t = setup();
    const both = new MemoryJournal();
    expect((await t.operational(both).run()).state).toBe("completed");
    const again = t.rehearsal(both);
    expect((await again.run()).state).toBe("completed");
    expect(again.world.refunds).toHaveLength(2);
  });

  it("resolves a lost send by reading inside the rehearsal, and a cancel stops new sends", async () => {
    const s = setup();
    const r = s.rehearsal();
    r.deps.retry = { maxAttempts: 1 };
    const stripe = r.deps.providers.stripe;
    let lose = true;
    r.deps.providers.stripe = {
      ...stripe,
      dispatch: async (req, ctx) => {
        const res = await stripe.dispatch(req, ctx);
        if (!lose) return res;
        lose = false;
        return { kind: "unknown", error: "response lost (injected)" };
      },
    };
    const first = await r.run();
    expect(outcomes(first.receipts).refund_001).toBe("unknown_outcome");
    const effects = r.world.effects.length;

    // Cancelled: the read-only pass reads the lost refund back and sends nothing new.
    s.cancelled.add(RID);
    const pass = await r.run();
    expect(pass.state).toBe("cancelled");
    expect(outcomes(pass.receipts).refund_001).toBe("confirmed");
    expect(r.world.effects.length).toBe(effects);
    expect(r.world.refunds.filter((x) => x.charge === "ch_fixture_001")).toHaveLength(1);
  });

  // T2.28 (#296): the refund lands, then its receipt can't be saved. The report has no result for
  // it and must not claim it never ran; the verdict stays unknown and the kept tenant is said so.
  it("reports a landed send whose receipt didn't settle as not recorded, never as not sent", async () => {
    const s = setup();
    const r = s.rehearsal();
    const settle = r.journal.settle.bind(r.journal);
    r.journal.settle = async (step) => {
      if (step.receipt.actionId === "refund_001" && step.receipt.outcome === "confirmed") {
        throw new Error("journal unavailable (injected)");
      }
      return settle(step);
    };
    const result = await r.run();
    expect(r.world.refunds.filter((x) => x.charge === "ch_fixture_001")).toHaveLength(1);
    expect(String(result.error)).toContain("journal unavailable");
    expect(result.receipts.map((x) => x.actionId)).not.toContain("refund_001");
    // The attempt was dispatched and never settled, which is what keeps the tenant for reads.
    const sent = [...r.journal.attempts.values()].filter((a) => a.actionId === "refund_001");
    expect(sent.map((a) => a.state)).toEqual(["dispatched"]);

    const report = rehearsalReport(
      {
        ...rehearsalJobFixture(),
        rehearsalId: RID,
        plan: { orgId: s.manifest.orgId, planId: s.manifest.planId, revision: 1, planHash: s.hash },
      },
      s.manifest,
      result.receipts,
      {
        state: "failed",
        limitations: [String(result.error), IN_FLIGHT_KEPT],
        notFromEvidence: [],
        startedAt: "2026-10-21T12:00:00.000Z",
        finishedAt: "2026-10-21T12:01:00.000Z",
        versions: { ...FIXTURE_REHEARSAL_VERSIONS, verifier: VERIFIER_VERSION },
        evidence: "fixture",
        verifications: new Map(),
      },
    );
    const refund = report.steps.find((x) => x.actionId === "refund_001");
    expect(refund?.result).toBeNull();
    expect(refund?.verification.status).toBe("unverified");
    expect(refund?.verification.detail).toBe(
      "no result was recorded for this step, so it cannot be verified",
    );
    expect(JSON.stringify(report)).not.toMatch(/never ran/i);
    expect(report.verdict).toBe("unknown");
    expect(report.limitations).toContain(IN_FLIGHT_KEPT);
    expect(ExecutionRehearsalReport.safeParse(report).success).toBe(true);
  });

  it("keeps a cancelled rehearsal unresolved while its own lost send can't be read (review)", async () => {
    const s = setup();
    const r = s.rehearsal();
    r.deps.retry = { maxAttempts: 1 };
    const stripe = r.deps.providers.stripe;
    let lose = true;
    r.deps.providers.stripe = {
      ...stripe,
      dispatch: async (req, ctx) => {
        const res = await stripe.dispatch(req, ctx);
        if (!lose) return res;
        lose = false;
        return { kind: "unknown", error: "response lost (injected)" };
      },
    };
    await r.run();
    r.deps.providers.stripe = {
      ...r.deps.providers.stripe,
      reconcile: async () => {
        throw new Error("read unavailable (injected)");
      },
    };
    s.cancelled.add(RID);
    const pass = await r.run();
    expect(pass.state).toBe("cancelled");
    expect(pass.unresolved).toBe(true);
    expect(r.journal.events.at(-1)?.type).toBe("run.stopped");
  });

  it("isn't made unresolved by an operational send in flight in a shared journal (review)", async () => {
    const s = setup();
    const shared = new MemoryJournal();
    const o = s.operational(shared);
    o.deps.retry = { maxAttempts: 1 };
    const stripe = o.deps.providers.stripe;
    o.deps.providers.stripe = {
      ...stripe,
      dispatch: async () => ({ kind: "unknown", error: "response lost (injected)" }),
      reconcile: async () => ({ kind: "indeterminate", detail: "can't tell (injected)" }),
    };
    await o.run(); // leaves operational refunds in flight
    s.cancelled.add(RID);
    const pass = await s.rehearsal(shared).run();
    expect(pass.state).toBe("cancelled");
    expect(pass.unresolved).toBeUndefined();
  });

  it("refuses a rehearsal that would stop halfway: a vendor the plan writes to has no world (review)", async () => {
    const s = setup();
    const r = s.rehearsal();
    r.deps.worlds = { stripe: r.deps.worlds.stripe };
    const result = await r.run();
    expect(result.refusal).toBe("no rehearsal provider for zendesk");
    expect(r.world.effects).toEqual([]);
  });

  it("compensates inside the rehearsal, under its own undo keys (review)", async () => {
    const s = setup();
    const r = s.rehearsal();
    const zendesk = r.deps.providers.zendesk;
    let firstNote = true;
    r.deps.providers.zendesk = {
      ...zendesk,
      dispatch: async (req, ctx) => {
        // The first private note (case 1's) is refused, so case 1's patch is undone.
        if (req.body.includes('"comment"') && !req.body.includes("safe_update") && firstNote) {
          firstNote = false;
          return { kind: "rejected", status: 422, body: { error: "injected" }, retryable: false };
        }
        return zendesk.dispatch(req, ctx);
      },
    };
    r.deps.compensate = createCompensator({
      providers: r.deps.providers,
      worlds: r.deps.worlds,
      clock: r.deps.clock,
    });
    const result = await r.run();
    expect(outcomes(result.receipts)).toMatchObject({
      note_001: "rejected",
      patch_001: "compensated",
    });
    const patchAttempts = [...r.journal.attempts.values()].filter(
      (a) => a.actionId === "patch_001",
    );
    expect(patchAttempts.length).toBeGreaterThan(1); // the forward patch and its undo
    expect(patchAttempts.every((a) => a.operationKey.startsWith(`rh_${RID}_op_`))).toBe(true);
    expect(r.world.tickets.get("5531")?.priority).toBe("normal");
  });
});

/** T4.13 G3: a precedent withdrawn after planning refuses the rehearsal, as it refuses apply. */
describe("precedent citations at rehearsal admission", () => {
  const AREA = "billing.duplicate_charge";
  const digest = "d".repeat(64);
  const basis = {
    citations: [
      { id: "dup-refund", version: 2, digest, appliesTo: AREA, factIds: ["f_1"], traceId: "t_1" },
    ],
    epochs: { [AREA]: 3 },
  };
  const inForce: RegistrySnapshot = {
    active: new Map([["dup-refund", { version: 2, digest }]]),
    epochs: new Map([[AREA, 3]]),
  };
  const withdrawn: RegistrySnapshot = { active: new Map(), epochs: new Map([[AREA, 3]]) };

  /** The stored plan now cites `dup-refund` v2; the job names its hash. */
  function citing(registry?: RegistrySnapshot) {
    const s = setup();
    const manifest = { ...s.manifest, precedentBasis: basis };
    const hash = planHash(manifest);
    s.store.plans.set(`${manifest.planId}@1`, { planHash: hash, manifest });
    const r = s.rehearsal();
    if (registry) r.deps.precedents = { snapshot: async () => registry };
    const job = {
      orgId: manifest.orgId,
      rehearsalId: RID,
      planId: manifest.planId,
      revision: 1,
      planHash: hash,
    };
    return { ...s, r, job };
  }

  it("rehearses a plan whose cited precedent is still in force", async () => {
    const { r, job } = citing(inForce);
    expect((await executeRehearsal(job, r.deps)).state).toBe("completed");
  });

  it("refuses one whose precedent was withdrawn, naming it, and sends nothing", async () => {
    const { r, job } = citing(withdrawn);
    const out = await executeRehearsal(job, r.deps);
    expect(out.state).toBe("failed");
    expect(out.refusal).toMatch(
      /precedent changed since planning: dup-refund v2 is withdrawn \(none in force\)/,
    );
    expect(r.world.effects).toEqual([]);
    expect(r.journal.attempts.size).toBe(0);
  });

  it("refuses one that cites precedents when no registry is configured", async () => {
    const { r, job } = citing();
    expect((await executeRehearsal(job, r.deps)).refusal).toMatch(/no precedent registry/);
  });

  it("still reads back a lost send after the precedent is withdrawn (read-only pass)", async () => {
    const { r, job } = citing(inForce);
    r.deps.retry = { maxAttempts: 1 };
    const stripe = r.deps.providers.stripe;
    let lose = true;
    r.deps.providers.stripe = {
      ...stripe,
      dispatch: async (req, ctx) => {
        const res = await stripe.dispatch(req, ctx);
        if (!lose) return res;
        lose = false;
        return { kind: "unknown", error: "response lost (injected)" };
      },
    };
    expect(outcomes((await executeRehearsal(job, r.deps)).receipts).refund_001).toBe(
      "unknown_outcome",
    );
    const effects = r.world.effects.length;
    r.deps.precedents = { snapshot: async () => withdrawn };
    const pass = await reconcileRehearsal(job, r.deps);
    expect(pass.refusal ?? null).toBeNull();
    expect(outcomes(pass.receipts).refund_001).toBe("confirmed");
    expect(r.world.effects.length).toBe(effects);
  });
});
