import type { ApprovalGrant, PlanManifest, ReplayBundle } from "@rehearsal/contracts";
import { type BillingPolicyV1, executeRun, operationKey, planHash } from "@rehearsal/core";
import {
  FakeClock,
  type FakeWorld,
  happyPathBundle,
  MemoryApplyStore,
  MemoryJournal,
  worldFromManifest,
} from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import policy from "../../../scenarios/billing/policy.v1.json" with { type: "json" };

const POLICY = policy as BillingPolicyV1;
const RUN = "run_1";
const APPROVAL = "grant_1";

/** Store, journal and an identical operational world for one bundle; the grant can be altered. */
function setup(bundle: ReplayBundle, grantOver: Partial<ApprovalGrant> = {}) {
  const manifest = bundle.manifest;
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
    ...grantOver,
  });
  const world = worldFromManifest(manifest.observations);
  const journal = new MemoryJournal();
  let n = 0;
  const deps = {
    store,
    journal,
    clock,
    providers: { stripe: world.provider("stripe"), zendesk: world.provider("zendesk") },
    worlds: {
      stripe: { world: "operational", tenant: "test" },
      zendesk: { world: "operational", tenant: "test" },
    } as const,
    policies: [POLICY],
    newId: (prefix: string) => `${prefix}_${++n}`,
  };
  const job = {
    orgId: manifest.orgId,
    runId: RUN,
    planId: manifest.planId,
    revision: 1,
    planHash: hash,
  };
  return { manifest, hash, store, world, journal, deps, job, run: () => executeRun(job, deps) };
}

const outcomes = (receipts: { actionId: string; outcome: string }[]) =>
  Object.fromEntries(receipts.map((r) => [r.actionId, r.outcome]));

const refundsFor = (world: FakeWorld, manifest: PlanManifest) =>
  world.refunds.filter((r) =>
    manifest.actions.some((a) => a.kind === "stripe.refund.create" && a.args.chargeId === r.charge),
  );

describe("happy-path bundle on the fake provider", () => {
  it("applies every action and matches the expected outcomes", async () => {
    const bundle = happyPathBundle();
    const { run, world, manifest } = setup(bundle);
    const result = await run();

    expect(result.refusal).toBeNull();
    expect(result.state).toBe("completed");
    expect(outcomes(result.receipts)).toEqual(
      Object.fromEntries(bundle.expected.map((e) => [e.actionId, e.outcome])),
    );
    expect(refundsFor(world, manifest)).toHaveLength(2);
    expect(world.charges.get("ch_fixture_001")?.amount_refunded).toBe(4210);
    expect(world.tickets.get("5531")?.priority).toBe("high");
  });

  it("writes the refund ID returned by the operational world into the note", async () => {
    const { run, world } = setup(happyPathBundle());
    await run();
    const refund = world.refunds.find((r) => r.charge === "ch_fixture_001");
    const [note] = world.tickets.get("5531")?.comments ?? [];
    expect(note?.public).toBe(false);
    expect(note?.body).toContain(refund?.id);
    expect(note?.body).toContain("42.10 CAD");
  });

  it("journals the exact bytes as dispatched before the request leaves", async () => {
    const { deps, journal, hash, job } = setup(happyPathBundle());
    const stripe = deps.providers.stripe;
    const seen: string[] = [];
    deps.providers.stripe = {
      ...stripe,
      dispatch: async (req, ctx) => {
        const [attempt] = await journal.attemptsFor(hash, "refund_001");
        if (attempt && seen.length === 0) {
          expect(attempt.state).toBe("dispatched");
          expect(attempt.request.body).toBe(req.body);
        }
        seen.push(req.body);
        return stripe.dispatch(req, ctx);
      },
    };
    await executeRun(job, deps);
    expect(seen.length).toBe(2);
  });

  it("is a no-op when the same job runs again after completing", async () => {
    const { run, world } = setup(happyPathBundle());
    await run();
    const effects = world.effects.length;
    const again = await run();
    expect(world.effects.length).toBe(effects);
    expect(again.receipts).toEqual([]);
    expect(again.state).toBe("completed");
  });
});

describe("admission refuses and dispatches nothing", () => {
  it.each<[string, (s: ReturnType<typeof setup>) => void]>([
    ["no stored run", (s) => s.store.runs.clear()],
    [
      "a revoked grant",
      (s) => {
        const g = s.store.grants.get(APPROVAL);
        if (g) s.store.grants.set(APPROVAL, { ...g, revokedAt: "2026-10-21T11:30:00.000Z" });
      },
    ],
    [
      "an expired grant",
      (s) => {
        const g = s.store.grants.get(APPROVAL);
        if (g) s.store.grants.set(APPROVAL, { ...g, expiresAt: "2026-10-21T11:59:59.000Z" });
      },
    ],
    [
      "a grant without the finance role",
      (s) => {
        const g = s.store.grants.get(APPROVAL);
        if (g) s.store.grants.set(APPROVAL, { ...g, roles: ["support_lead"] });
      },
    ],
    [
      "a stored manifest that no longer matches its hash",
      (s) => {
        const tampered = structuredClone(s.manifest);
        if (tampered.actions[0]?.kind === "stripe.refund.create")
          tampered.actions[0].args.amount.amountMinor = 99_99;
        s.store.plans.set(`${s.manifest.planId}@1`, { planHash: s.hash, manifest: tampered });
      },
    ],
  ])("%s", async (_label, mutate) => {
    const s = setup(happyPathBundle());
    mutate(s);
    const result = await s.run();
    expect(result.state).toBe("failed");
    expect(result.refusal).not.toBeNull();
    expect(s.world.effects).toEqual([]);
    expect(s.journal.attempts.size).toBe(0);
  });

  it("refuses a job whose hash differs from the stored run", async () => {
    const s = setup(happyPathBundle());
    const result = await executeRun({ ...s.job, planHash: "f".repeat(64) }, s.deps);
    expect(result.refusal).toMatch(/does not match/);
    expect(s.world.effects).toEqual([]);
  });
});

describe("partial outcomes are honest", () => {
  it("a rejected refund skips its note; the run is partial, not completed", async () => {
    const s = setup(happyPathBundle());
    s.world.fault("/v1/refunds", { kind: "reject", status: 402, retryable: false });
    const result = await s.run();
    expect(outcomes(result.receipts)).toMatchObject({
      refund_001: "rejected",
      note_001: "skipped_dependency",
      patch_001: "confirmed",
      refund_002: "confirmed",
      note_002: "confirmed",
    });
    expect(result.state).toBe("partial");
  });

  it("a lost response becomes unknown_outcome and is never blindly re-sent", async () => {
    const s = setup(happyPathBundle());
    s.world.fault("/v1/refunds", { kind: "drop_response_after_commit" });
    const first = await s.run();
    expect(outcomes(first.receipts)).toMatchObject({
      refund_001: "unknown_outcome",
      note_001: "skipped_dependency",
    });

    // Restart: the same job runs again with the same journal. The refund must not be issued twice.
    const second = await s.run();
    expect(outcomes(second.receipts)).toMatchObject({ refund_001: "held" });
    expect(s.world.refunds.filter((r) => r.charge === "ch_fixture_001")).toHaveLength(1);
  });
});

describe("operation keys", () => {
  it("stay the same across plan revisions for the same obligation", () => {
    const { manifest } = setup(happyPathBundle());
    const refund = manifest.actions[0];
    if (!refund) throw new Error("fixture has no actions");
    expect(operationKey("org_demo", refund)).toBe(
      operationKey("org_demo", { ...refund, id: "renamed" }),
    );
    expect(operationKey("org_demo", refund)).not.toBe(operationKey("org_other", refund));
  });
});
