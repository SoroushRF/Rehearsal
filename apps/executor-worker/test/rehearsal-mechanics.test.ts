import {
  type BillingPolicy,
  type ExecutorDeps,
  executeRehearsal,
  executeRun,
  type ProviderPort,
  planHash,
  type RehearsalExecutorDeps,
  rehearsalJournalHash,
  rehearsalTenant,
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
});
