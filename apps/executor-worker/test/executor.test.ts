import type { ApprovalGrant, PlanManifest, ReplayBundle } from "@rehearsal/contracts";
import {
  type BillingPolicy,
  type BillingPolicyV1,
  caseGroups,
  createReadGuard,
  type ExecutorDeps,
  executeRun,
  fingerprint,
  operationKey,
  PLAN_LOCKED,
  type ProviderPort,
  planHash,
  RUN_CANCELLED,
  topoOrder,
} from "@rehearsal/core";
import {
  FakeClock,
  type FakeWorld,
  happyPathBundle,
  MemoryApplyStore,
  MemoryJournal,
  unknownOutcomeBundle,
  worldFromManifest,
} from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import policy from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import policyV3 from "../../../scenarios/billing/policy.v3.json" with { type: "json" };

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
  const sleeps: number[] = [];
  const deps: ExecutorDeps & { providers: Record<"stripe" | "zendesk", ProviderPort> } = {
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
    // Retries sleep instantly in tests; the delays they asked for are recorded.
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
  const job = {
    orgId: manifest.orgId,
    runId: RUN,
    planId: manifest.planId,
    revision: 1,
    planHash: hash,
  };
  return {
    manifest,
    hash,
    store,
    world,
    journal,
    deps,
    job,
    sleeps,
    run: () => executeRun(job, deps),
  };
}

const outcomes = (receipts: { actionId: string; outcome: string }[]) =>
  Object.fromEntries(receipts.map((r) => [r.actionId, r.outcome]));

const refundsFor = (world: FakeWorld, manifest: PlanManifest) =>
  world.refunds.filter((r) =>
    manifest.actions.some((a) => a.kind === "stripe.refund.create" && a.args.chargeId === r.charge),
  );

describe("happy-path bundle on the fake provider", () => {
  it("preserves a confirmed refund but stops fresh writes when approval is revoked mid-run", async () => {
    const s = setup(happyPathBundle());
    const dispatch = s.deps.providers.stripe.dispatch;
    s.deps.providers.stripe.dispatch = async (req, ctx) => {
      const result = await dispatch(req, ctx);
      const grant = s.store.grants.get(APPROVAL);
      if (!grant) throw new Error("missing grant");
      s.store.grants.set(APPROVAL, { ...grant, revokedAt: "2026-10-21T12:00:00Z" });
      return result;
    };
    const out = await s.run();
    expect(out.receipts.find((r) => r.actionId === "refund_001")?.outcome).toBe("confirmed");
    expect(out.receipts.find((r) => r.actionId === "patch_001")).toMatchObject({
      outcome: "held",
      holdReason: { kind: "approval_invalid" },
    });
    expect(s.world.effects).toHaveLength(1);
    expect(out.state).toBe("partial");
  });

  it("holds a fresh retry if the grant expires during backoff", async () => {
    const s = setup(happyPathBundle());
    s.world.fault("/v1/refunds", { kind: "reject", status: 429, retryable: true });
    s.deps.sleep = async () => {
      if (s.deps.clock instanceof FakeClock) s.deps.clock.advance(7_200_000);
    };
    const out = await s.run();
    expect(out.receipts.find((r) => r.actionId === "refund_001")).toMatchObject({
      outcome: "held",
      holdReason: { kind: "approval_invalid" },
    });
    expect(s.world.effects).toHaveLength(0);
    expect(await s.journal.attemptsFor(s.hash, "refund_001")).toHaveLength(1);
  });

  it("does not replay an unknown send after its approval is revoked", async () => {
    const s = setup(happyPathBundle());
    s.world.fault("/v1/refunds", { kind: "drop_response_after_commit" });
    s.deps.sleep = async () => {
      const grant = s.store.grants.get(APPROVAL);
      if (grant) grant.revokedAt = "2026-10-21T12:00:00Z";
    };
    const out = await s.run();
    expect(out.receipts.find((r) => r.actionId === "refund_001")?.outcome).toBe("unknown_outcome");
    expect(await s.journal.attemptsFor(s.hash, "refund_001")).toHaveLength(1);
    expect(s.world.effects).toHaveLength(1);
  });

  it.each([{ id: "other" }, { priority: "urgent" }, { status: "invalid" }])(
    "keeps a contradictory ticket patch response unknown: %j",
    async (change) => {
      const s = setup(happyPathBundle());
      const dispatch = s.deps.providers.zendesk.dispatch;
      s.deps.providers.zendesk.dispatch = async (req, ctx) => {
        const result = await dispatch(req, ctx);
        if (result.kind !== "confirmed") return result;
        const body = result.body as { ticket: object };
        return { ...result, body: { ticket: { ...body.ticket, ...change } } };
      };
      expect((await s.run()).receipts.find((r) => r.actionId === "patch_001")?.outcome).toBe(
        "unknown_outcome",
      );
    },
  );
  it.each([
    { status: "failed" },
    { status: "pending" },
    { amount: 1 },
    { charge: "ch_other" },
    { currency: "usd" },
    { id: "" },
  ])("never confirms or announces a contradictory refund response: %j", async (change) => {
    const s = setup(happyPathBundle());
    s.deps.retry = { maxAttempts: 1 };
    const dispatch = s.deps.providers.stripe.dispatch;
    s.deps.providers.stripe.dispatch = async (req, ctx) => {
      const result = await dispatch(req, ctx);
      return result.kind === "confirmed"
        ? { ...result, body: { ...(result.body as object), ...change } }
        : result;
    };
    const out = await s.run();
    expect(out.receipts.find((r) => r.actionId === "refund_001")?.outcome).toBe("unknown_outcome");
    expect(out.receipts.find((r) => r.actionId === "note_001")?.outcome).toBe("skipped_dependency");
    expect(s.world.tickets.get("5531")?.comments).toHaveLength(0);
  });

  it("holds a contradictory refund reconciliation instead of releasing its note", async () => {
    const s = setup(happyPathBundle());
    s.deps.retry = { maxAttempts: 1 };
    s.world.fault("/v1/refunds", { kind: "drop_response_after_commit" });
    await s.run();
    const reconcile = s.deps.providers.stripe.reconcile;
    s.deps.providers.stripe.reconcile = async (...args) => {
      const result = await reconcile(...args);
      return result.kind === "applied"
        ? { ...result, effect: { ...result.effect, "refund.status": "failed" } }
        : result;
    };
    const out = await s.run();
    expect(out.receipts.find((r) => r.actionId === "refund_001")?.outcome).toBe("held");
    expect(s.world.tickets.get("5531")?.comments).toHaveLength(0);
  });
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
        if (seen.length === 0) {
          expect(attempt?.state).toBe("dispatched");
          expect(attempt?.request.body).toBe(req.body);
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
      "a grant dated in the future",
      (s) => {
        const g = s.store.grants.get(APPROVAL);
        if (g) s.store.grants.set(APPROVAL, { ...g, grantedAt: "2026-10-21T12:00:01.000Z" });
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
    s.deps.retry = { maxAttempts: 1 }; // no in-run re-send: the restart path
    s.world.fault("/v1/refunds", { kind: "drop_response_after_commit" });
    const first = await s.run();
    expect(outcomes(first.receipts)).toMatchObject({
      refund_001: "unknown_outcome",
      note_001: "skipped_dependency",
    });

    // Restart: the same job runs again with the same journal. A read finds the refund the lost
    // response created, so it is confirmed without a second send, and its note follows.
    const second = await s.run();
    expect(outcomes(second.receipts)).toMatchObject({
      refund_001: "confirmed",
      note_001: "confirmed",
    });
    expect(second.receipts.find((r) => r.actionId === "refund_001")?.limitations.join(" ")).toMatch(
      /found by reading the provider; not re-sent/,
    );
    expect(s.world.refunds.filter((r) => r.charge === "ch_fixture_001")).toHaveLength(1);
  });
});

/** Store revision 2 of the same plan (optionally changed) with its own run and grant. */
function addRevision(s: ReturnType<typeof setup>, change: (m: PlanManifest) => void = () => {}) {
  const manifest = structuredClone({ ...s.manifest, revision: 2, parentRevision: 1 });
  change(manifest);
  const hash = planHash(manifest);
  s.store.plans.set(`${manifest.planId}@2`, { planHash: hash, manifest });
  s.store.runs.set("run_2", {
    planId: manifest.planId,
    revision: 2,
    planHash: hash,
    approvalId: "grant_2",
  });
  const grant = s.store.grants.get(APPROVAL);
  if (!grant) throw new Error("setup has no grant");
  s.store.grants.set("grant_2", { ...grant, id: "grant_2", revision: 2, planHash: hash });
  const job = {
    orgId: manifest.orgId,
    runId: "run_2",
    planId: manifest.planId,
    revision: 2,
    planHash: hash,
  };
  return { manifest, run: () => executeRun(job, s.deps) };
}

describe("re-approved revisions", () => {
  it("adopt confirmed effects of an identical earlier revision instead of re-sending", async () => {
    const s = setup(happyPathBundle());
    await s.run();
    const effects = s.world.effects.length;
    const rev2 = await addRevision(s).run();
    expect(rev2.state).toBe("completed");
    expect(rev2.error).toBeNull();
    expect(s.world.effects.length).toBe(effects);
    expect(rev2.receipts.every((r) => r.limitations.some((l) => l.includes("not re-sent")))).toBe(
      true,
    );
  });

  it("hold a step whose content changed after it was applied", async () => {
    const s = setup(happyPathBundle());
    await s.run();
    const rev2 = await addRevision(s, (m) => {
      const refund = m.actions.find((a) => a.id === "refund_001");
      if (refund?.kind === "stripe.refund.create") refund.args.amount.amountMinor = 4000;
    }).run();
    expect(outcomes(rev2.receipts)).toMatchObject({
      refund_001: "held",
      note_001: "skipped_dependency",
    });
    expect(s.world.refunds.filter((r) => r.charge === "ch_fixture_001")).toHaveLength(1);
  });
});

describe("failures inside the executor", () => {
  it("a crash while settling a confirmed step leaves it in flight, never re-sent", async () => {
    const s = setup(happyPathBundle());
    s.journal.failNextSettle = true;
    const first = await s.run();
    expect(first.error).toMatch(/journal unavailable/);
    // Not "finished": the worker retries a run that stopped on an error.
    expect(s.journal.events.at(-1)?.type).toBe("run.stopped");

    // Restart: the refund was applied before the crash; a read finds it, nothing is re-sent.
    const second = await s.run();
    expect(outcomes(second.receipts)).toMatchObject({
      refund_001: "confirmed",
      note_001: "confirmed",
    });
    expect(s.world.refunds.filter((r) => r.charge === "ch_fixture_001")).toHaveLength(1);
  });

  it("an unreadable confirmed response is recorded as unknown_outcome", async () => {
    const s = setup(happyPathBundle());
    s.deps.retry = { maxAttempts: 1 }; // without the idempotent replay that would resolve it
    const stripe = s.deps.providers.stripe;
    let first = true;
    s.deps.providers.stripe = {
      ...stripe,
      dispatch: async (req, ctx) => {
        const res = await stripe.dispatch(req, ctx);
        if (!first) return res;
        first = false;
        return { kind: "confirmed", status: 200, body: { unexpected: true } };
      },
    };
    const result = await s.run();
    expect(outcomes(result.receipts)).toMatchObject({
      refund_001: "unknown_outcome",
      note_001: "skipped_dependency",
    });
    expect(result.error).toBeNull();
  });

  /** Every refund is refused (402), and settling `patch_002` always fails: each pass errors. */
  function erroringEveryPass() {
    const s = setup(happyPathBundle());
    const stripe = s.deps.providers.stripe;
    s.deps.providers.stripe = {
      ...stripe,
      dispatch: async () => ({ kind: "rejected", status: 402, body: {}, retryable: false }),
    };
    const settle = s.journal.settle.bind(s.journal);
    s.journal.settle = async (step) => {
      if (step.receipt.actionId === "patch_002") throw new Error("settle failed (injected)");
      return settle(step);
    };
    const count = async (actionId: string) =>
      (await s.journal.receiptsFor(s.hash)).filter((r) => r.actionId === actionId).length;
    return { s, count };
  }

  it("a retried run writes no duplicate receipt for a step that settled the same way", async () => {
    const { s, count } = erroringEveryPass();
    for (let i = 0; i < 3; i++) {
      const result = await s.run();
      expect(result.error).toMatch(/settle failed/);
      expect(outcomes(result.receipts)).toMatchObject({
        refund_001: "rejected",
        note_001: "skipped_dependency",
      });
    }
    expect(await count("refund_001")).toBe(1);
    expect(await count("note_001")).toBe(1);
    expect(await count("patch_001")).toBe(1);
    const types = s.journal.events.map((e) => e.type);
    expect(types.filter((t) => t === "run.stopped")).toHaveLength(3);
    expect(types).not.toContain("run.finished");

    // A new run of the same hash keeps its own record.
    s.store.runs.set(
      "run_2",
      s.store.runs.get(RUN) as NonNullable<ReturnType<typeof s.store.runs.get>>,
    );
    await executeRun({ ...s.job, runId: "run_2" }, s.deps);
    expect(await count("refund_001")).toBe(2);
    expect(await count("note_001")).toBe(2);

    // run_2 now holds the latest receipts, so a retry of run_1 writes its own again.
    await s.run();
    expect(await count("note_001")).toBe(3);
  });

  it("a rejected request is not re-sent when the job runs again", async () => {
    const s = setup(happyPathBundle());
    s.world.fault("/v1/refunds", { kind: "reject", status: 402, retryable: false });
    await s.run();
    const refunds = s.world.refunds.length;
    const again = await s.run();
    expect(outcomes(again.receipts)).toMatchObject({ refund_001: "rejected" });
    expect(s.world.refunds.length).toBe(refunds);
  });
});

describe("second-round review fixes", () => {
  it("a failed event write after settling doesn't change the outcome", async () => {
    const s = setup(happyPathBundle());
    s.journal.failNextEvent = "step.receipt";
    const result = await s.run();
    expect(result.state).toBe("completed");
    expect(outcomes(result.receipts)).toMatchObject({ refund_001: "confirmed" });
  });

  it("an error after dispatch labels the run held, not failed", async () => {
    const s = setup(happyPathBundle());
    s.journal.failNextSettle = true;
    const result = await s.run();
    expect(result.error).not.toBeNull();
    expect(result.state).toBe("held");
  });

  it("a never-sent prepared attempt from revision 1 doesn't block a changed revision 2", async () => {
    const s = setup(happyPathBundle());
    s.journal.failNextTransitionTo = "dispatched";
    const rev1 = await s.run();
    expect(rev1.error).toMatch(/crash before dispatched/);
    expect(s.world.refunds).toHaveLength(0);

    const rev2 = addRevision(s, (m) => {
      const refund = m.actions.find((a) => a.id === "refund_001");
      if (refund?.kind === "stripe.refund.create") refund.args.amount.amountMinor = 4000;
    });
    const result = await rev2.run();
    expect(outcomes(result.receipts)).toMatchObject({
      refund_001: "confirmed",
      note_001: "confirmed",
    });
    const refunds = s.world.refunds.filter((r) => r.charge === "ch_fixture_001");
    expect(refunds.map((r) => r.amount)).toEqual([4000]);

    // The send is credited to revision 2's hash, under a new attempt; revision 1's row stays unsent.
    const attempts = [...s.journal.attempts.values()].filter((a) => a.actionId === "refund_001");
    expect(
      attempts.map((a) => [a.planHash === s.hash ? "rev1" : "rev2", a.state, a.attemptNo]),
    ).toEqual([
      ["rev1", "prepared", 1],
      ["rev2", "confirmed", 2],
    ]);
  });

  it("guards see confirmed receipts, including those from an earlier run of the same hash", async () => {
    const s = setup(happyPathBundle());
    s.deps.guard = async (action) =>
      action.id === "note_002" ? { kind: "row_changed", observationId: "x", fields: ["y"] } : null;
    const first = await s.run();
    expect(outcomes(first.receipts)).toMatchObject({ note_002: "held" });

    let seen: string[] = [];
    s.deps.guard = async (action, ctx) => {
      if (action.id === "note_002") seen = ctx.confirmedReceipts.map((r) => r.actionId);
      return null;
    };
    const second = await s.run();
    expect(outcomes(second.receipts)).toMatchObject({ note_002: "confirmed" });
    expect([...seen].sort()).toEqual([
      "note_001",
      "patch_001",
      "patch_002",
      "refund_001",
      "refund_002",
    ]);
  });

  it("guards don't run for effects adopted from an earlier revision", async () => {
    const s = setup(happyPathBundle());
    await s.run();
    s.deps.guard = async () => ({ kind: "row_changed", observationId: "x", fields: ["y"] });
    const rev2 = await addRevision(s).run();
    expect(rev2.state).toBe("completed");
  });

  it("refuses a grant whose timestamps can't be read", async () => {
    const s = setup(happyPathBundle(), { expiresAt: "not-a-date" });
    const result = await s.run();
    expect(result.refusal).toMatch(/unreadable/);
    expect(s.world.effects).toEqual([]);
  });
});

describe("third-round review fixes", () => {
  it("re-running an adopted revision writes no duplicate receipts and guards see each action once", async () => {
    const s = setup(happyPathBundle());
    s.deps.guard = async (action) =>
      action.id === "note_002" ? { kind: "row_changed", observationId: "x", fields: ["y"] } : null;
    await s.run();

    const rev2 = addRevision(s);
    let seen: string[] = [];
    s.deps.guard = async (action, ctx) => {
      if (action.id === "note_002") seen = ctx.confirmedReceipts.map((r) => r.actionId);
      return null;
    };
    await rev2.run();
    await rev2.run();
    expect(new Set(seen).size).toBe(seen.length);

    const rev2Hash = planHash(rev2.manifest);
    const confirmed = s.journal.receipts.filter(
      (r) => r.planHash === rev2Hash && r.outcome === "confirmed",
    );
    expect(confirmed.map((r) => r.actionId).sort()).toEqual([
      "note_001",
      "note_002",
      "patch_001",
      "patch_002",
      "refund_001",
      "refund_002",
    ]);
  });

  /**
   * The interleaving the lock exists for: revision 1 has journaled its note attempt but not yet
   * marked it dispatched; revision 2 (identical) ignores that never-sent row and would send its
   * own. The note has no idempotency, so without the lock it is appended twice.
   */
  async function raceTwoRevisions(store: { lockPlan: ExecutorDeps["store"]["lockPlan"] } | null) {
    const s = setup(happyPathBundle());
    if (store) s.store.lockPlan = store.lockPlan;
    const rev2 = addRevision(s);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let paused: () => void = () => {};
    const reached = new Promise<void>((r) => {
      paused = r;
    });
    let held = false;
    s.journal.beforeTransition = async (attemptId, to) => {
      const attempt = s.journal.attempts.get(attemptId);
      if (!held && to === "dispatched" && attempt?.actionId === "note_001") {
        held = true;
        paused();
        await gate;
      }
    };
    const first = s.run();
    await reached;
    const second = await rev2.run();
    release();
    await first;
    return { s, second };
  }

  it("without the plan lock, the race appends the note twice (what the lock prevents)", async () => {
    const noLock = { lockPlan: async () => async () => {} };
    const { s } = await raceTwoRevisions(noLock);
    expect(s.world.tickets.get("5531")?.comments).toHaveLength(2);
  });

  it("with the plan lock, the second revision is deferred and the note is appended once", async () => {
    const { s, second } = await raceTwoRevisions(null);
    expect(second).toMatchObject({
      state: "held",
      refusal: "another run of this plan is applying",
    });
    expect(s.world.tickets.get("5531")?.comments).toHaveLength(1);
    expect(s.world.refunds).toHaveLength(2);
  });

  it("releases the plan lock even when the run throws", async () => {
    const s = setup(happyPathBundle());
    s.journal.failNextEvent = "run.admitted";
    await expect(s.run()).rejects.toThrow(/event write failed/);
    const again = await s.run();
    expect(again).toMatchObject({ state: "completed", refusal: null });
  });
});

describe("guarded patches whose stamp moves (T3.3 review)", () => {
  it("an identical revision adopts the patch even though our own writes moved the stamp", async () => {
    const s = setup(happyPathBundle());
    await s.run();
    const rev2 = await addRevision(s).run();
    expect(rev2.state).toBe("completed");
    const patch = rev2.receipts.find((r) => r.actionId === "patch_001");
    expect(patch?.limitations.join(" ")).toMatch(/not re-sent/);
  });

  it("a never-sent patch attempt is superseded when the stamp moved, then applied once", async () => {
    const s = setup(happyPathBundle());
    let crashed = false;
    s.journal.beforeTransition = async (attemptId, to) => {
      if (
        !crashed &&
        to === "dispatched" &&
        s.journal.attempts.get(attemptId)?.actionId === "patch_001"
      ) {
        crashed = true;
        throw new Error("crash before dispatched (injected)");
      }
    };
    const first = await s.run();
    expect(first.error).toMatch(/crash before dispatched/);
    s.world.teammateEdit("5531", "status", "pending"); // moves the stamp; nothing of ours was sent

    const second = await s.run();
    expect(outcomes(second.receipts)).toMatchObject({ patch_001: "confirmed" });
    const attempts = await s.journal.attemptsFor(s.hash, "patch_001");
    expect(attempts.map((a) => [a.state, a.attemptNo])).toEqual([
      ["prepared", 1],
      ["confirmed", 2],
    ]);
    expect(s.world.tickets.get("5531")?.priority).toBe("high");
  });

  it("a 409 conflict is rejected, and a re-run reports it rejected without re-sending", async () => {
    const s = setup(happyPathBundle());
    s.journal.beforeTransition = async (attemptId, to) => {
      if (to === "dispatched" && s.journal.attempts.get(attemptId)?.actionId === "patch_001") {
        s.journal.beforeTransition = null;
        s.world.teammateEdit("5531", "priority", "urgent"); // lands between our read and our write
      }
    };
    const first = await s.run();
    expect(outcomes(first.receipts)).toMatchObject({ patch_001: "rejected" });
    expect(s.world.tickets.get("5531")?.priority).toBe("urgent");

    const effects = s.world.effects.length;
    const second = await s.run();
    expect(outcomes(second.receipts)).toMatchObject({ patch_001: "rejected" });
    expect(second.receipts.find((r) => r.actionId === "patch_001")?.limitations.join(" ")).toMatch(
      /not re-sent/,
    );
    expect(s.world.effects.length).toBe(effects);
  });

  it.each(["patch_001", "note_001"])(
    "%s: a revision whose prepared row trails another revision's confirmed send adopts it, never re-sends",
    async (stepId) => {
      const s = setup(happyPathBundle());
      const rev2 = addRevision(s);
      const crashOnceBeforeDispatch = () => {
        let done = false;
        s.journal.beforeTransition = async (attemptId, to) => {
          if (
            !done &&
            to === "dispatched" &&
            s.journal.attempts.get(attemptId)?.actionId === stepId
          ) {
            done = true;
            throw new Error("crash before dispatched (injected)");
          }
        };
      };
      crashOnceBeforeDispatch();
      await s.run(); // rev1 leaves a prepared row
      crashOnceBeforeDispatch();
      await rev2.run(); // rev2 leaves its own prepared row, after rev1's
      s.journal.beforeTransition = null;
      expect((await s.run()).state).toBe("completed"); // rev1 sends its row

      const ticketWrites = () => s.world.effects.filter((e) => e.path.includes("5531")).length;
      const comments = () => s.world.tickets.get("5531")?.comments.length;
      const [writes, notes] = [ticketWrites(), comments()];
      const result = await rev2.run();
      expect(result.state).toBe("completed");
      expect(result.receipts.find((r) => r.actionId === stepId)?.limitations.join(" ")).toMatch(
        /not re-sent/,
      );
      expect(ticketWrites()).toBe(writes);
      expect(comments()).toBe(notes);
    },
  );

  it("refuses to apply when a vendor is configured for the planning world", async () => {
    const s = setup(happyPathBundle());
    s.deps.worlds = { ...s.deps.worlds, zendesk: { world: "planning", tenant: "test" } };
    const result = await s.run();
    expect(result.refusal).toMatch(/planning world/);
    expect(s.world.effects).toEqual([]);
  });
});

describe("retries (T3.4)", () => {
  it("an unreadable confirmed refund response is resolved by the idempotent replay", async () => {
    const s = setup(happyPathBundle());
    const stripe = s.deps.providers.stripe;
    let first = true;
    s.deps.providers.stripe = {
      ...stripe,
      dispatch: async (req, ctx) => {
        const res = await stripe.dispatch(req, ctx);
        if (!first) return res;
        first = false;
        return { kind: "confirmed", status: 200, body: { unexpected: true } };
      },
    };
    const result = await s.run();
    expect(outcomes(result.receipts)).toMatchObject({
      refund_001: "confirmed",
      note_001: "confirmed",
    });
    expect(s.world.refunds.filter((r) => r.charge === "ch_fixture_001")).toHaveLength(1);
  });

  const refundAttempts = async (s: ReturnType<typeof setup>) =>
    (await s.journal.attemptsFor(s.hash, "refund_001")).map((a) => [a.state, a.attemptNo]);
  const refundsOn = (s: ReturnType<typeof setup>, charge: string) =>
    s.world.refunds.filter((r) => r.charge === charge).length;

  it("retries a 429 after its Retry-After with identical bytes, and applies once", async () => {
    const s = setup(happyPathBundle());
    s.world.fault("/v1/refunds", {
      kind: "reject",
      status: 429,
      retryable: true,
      retryAfterMs: 1500,
    });
    const result = await s.run();
    expect(result.state).toBe("completed");
    expect(s.sleeps).toEqual([1500]);
    expect(await refundAttempts(s)).toEqual([
      ["rejected", 1],
      ["confirmed", 2],
    ]);
    const [a, b] = await s.journal.attemptsFor(s.hash, "refund_001");
    expect(b?.request).toEqual(a?.request);
    expect(refundsOn(s, "ch_fixture_001")).toBe(1);
    expect(result.receipts.find((r) => r.actionId === "refund_001")?.limitations).toContain(
      "sent 2 times with identical bytes",
    );
    expect(s.journal.events.filter((e) => e.type === "step.retry")).toHaveLength(1);
  });

  it("backs off exponentially without Retry-After, then gives up within the budget", async () => {
    const s = setup(happyPathBundle());
    s.deps.retry = { maxAttempts: 3, baseDelayMs: 100 };
    for (let i = 0; i < 3; i++)
      s.world.fault("/v1/refunds", { kind: "reject", status: 429, retryable: true });
    const first = await s.run();
    expect(s.sleeps).toEqual([100, 200]);
    const receipt = first.receipts.find((r) => r.actionId === "refund_001");
    expect(receipt?.outcome).toBe("rejected");
    expect(receipt?.limitations.join(" ")).toMatch(/retry budget exhausted/);
    expect(outcomes(first.receipts)).toMatchObject({ note_001: "skipped_dependency" });

    // A 429 had no effect, so a later run may send it again; this time it lands.
    const second = await s.run();
    expect(outcomes(second.receipts)).toMatchObject({
      refund_001: "confirmed",
      note_001: "confirmed",
    });
    expect(refundsOn(s, "ch_fixture_001")).toBe(1);
  });

  it("doesn't sleep through a Retry-After longer than the cap", async () => {
    const s = setup(happyPathBundle());
    s.world.fault("/v1/refunds", {
      kind: "reject",
      status: 429,
      retryable: true,
      retryAfterMs: 60_000,
    });
    const result = await s.run();
    expect(s.sleeps).toEqual([]);
    expect(outcomes(result.receipts)).toMatchObject({ refund_001: "rejected" });
  });

  it("never retries a validation or permission refusal", async () => {
    const s = setup(happyPathBundle());
    s.world.fault("/v1/refunds", { kind: "reject", status: 400, retryable: false });
    const result = await s.run();
    expect(s.sleeps).toEqual([]);
    expect(await refundAttempts(s)).toEqual([["rejected", 1]]);
    expect(outcomes(result.receipts)).toMatchObject({ refund_001: "rejected" });
  });

  it("re-sends a refund after a 5xx (idempotent key), applying it once", async () => {
    const s = setup(happyPathBundle());
    s.world.fault("/v1/refunds", { kind: "server_error" });
    const result = await s.run();
    expect(outcomes(result.receipts)).toMatchObject({
      refund_001: "confirmed",
      note_001: "confirmed",
    });
    expect(await refundAttempts(s)).toEqual([
      ["reconciled", 1],
      ["confirmed", 2],
    ]);
    expect(refundsOn(s, "ch_fixture_001")).toBe(1);
  });

  it("a lost refund response is resolved by the idempotent replay: one refund, nothing held", async () => {
    const s = setup(happyPathBundle());
    s.world.fault("/v1/refunds", { kind: "drop_response_after_commit" });
    const result = await s.run();
    expect(result.state).toBe("completed");
    expect(await refundAttempts(s)).toEqual([
      ["reconciled", 1],
      ["confirmed", 2],
    ]);
    expect(refundsOn(s, "ch_fixture_001")).toBe(1);
    // The note names the refund the replay returned, which is the one the lost response created.
    const refund = s.world.refunds.find((r) => r.charge === "ch_fixture_001");
    expect(s.world.tickets.get("5531")?.comments.at(-1)?.body).toContain(refund?.id);
  });

  it.each([
    ["429s until the budget runs out", { kind: "reject", status: 429, retryable: true }],
    ["a 403", { kind: "reject", status: 403, retryable: false }],
  ] as const)(
    "a lost refund response followed by %s is unknown_outcome, never rejected",
    async (_label, refusal) => {
      const s = setup(happyPathBundle());
      s.world.fault("/v1/refunds", { kind: "drop_response_after_commit" });
      for (let i = 0; i < 3; i++) s.world.fault("/v1/refunds", refusal);
      const result = await s.run();
      const receipt = result.receipts.find((r) => r.actionId === "refund_001");
      expect(receipt?.outcome).toBe("unknown_outcome");
      const [first] = await s.journal.attemptsFor(s.hash, "refund_001");
      expect(receipt?.holdReason).toEqual({ kind: "unresolved_outcome", attemptId: first?.id });
      expect(s.world.refunds.filter((r) => r.charge === "ch_fixture_001")).toHaveLength(1);
      expect(outcomes(result.receipts)).toMatchObject({ note_001: "skipped_dependency" });

      // A later run reconciles by reading: the lost send did apply, so it is confirmed, not re-sent.
      const again = await s.run();
      expect(outcomes(again.receipts)).toMatchObject({ refund_001: "confirmed" });
      expect(s.world.refunds.filter((r) => r.charge === "ch_fixture_001")).toHaveLength(1);
    },
  );

  it("says when Retry-After, not the budget, stopped the retries", async () => {
    const s = setup(happyPathBundle());
    s.world.fault("/v1/refunds", {
      kind: "reject",
      status: 429,
      retryable: true,
      retryAfterMs: 60_000,
    });
    const result = await s.run();
    expect(result.receipts.find((r) => r.actionId === "refund_001")?.limitations.join(" ")).toMatch(
      /exceeds the 10000 ms cap/,
    );
  });

  it("never re-sends a note after an unknown outcome (appends aren't idempotent)", async () => {
    const s = setup(happyPathBundle());
    const zendesk = s.deps.providers.zendesk;
    let dropped = false;
    s.deps.providers.zendesk = {
      ...zendesk,
      dispatch: async (req, ctx) => {
        const res = await zendesk.dispatch(req, ctx);
        if (!dropped && req.body.includes('"comment"')) {
          dropped = true;
          return { kind: "unknown", error: "response lost (injected)" };
        }
        return res;
      },
    };
    const result = await s.run();
    expect(outcomes(result.receipts)).toMatchObject({ note_001: "unknown_outcome" });
    expect(s.sleeps).toEqual([]);
    expect(s.world.tickets.get("5531")?.comments).toHaveLength(1);
  });
});

describe("reconcile through reads (T3.5)", () => {
  const advance = (s: ReturnType<typeof setup>, ms: number) =>
    (s.deps.clock as FakeClock).advance(ms);
  const states = async (s: ReturnType<typeof setup>, actionId: string) =>
    (await s.journal.attemptsFor(s.hash, actionId)).map((a) => [a.state, a.providerStatus]);
  /** Drop the response of the first Zendesk write whose body matches, after it applied (or not). */
  function dropZendesk(s: ReturnType<typeof setup>, match: string, applied = true) {
    const zendesk = s.deps.providers.zendesk;
    let done = false;
    s.deps.providers.zendesk = {
      ...zendesk,
      dispatch: async (req, ctx) => {
        if (done || !req.body.includes(match)) return zendesk.dispatch(req, ctx);
        done = true;
        if (applied) await zendesk.dispatch(req, ctx);
        return { kind: "unknown", error: "response lost (injected)" };
      },
    };
  }

  it("the unknown-outcome bundle passes with a restart: exactly one refund, every step confirmed", async () => {
    const bundle = unknownOutcomeBundle();
    const s = setup(bundle);
    s.deps.retry = { maxAttempts: 1 }; // the process "dies" before any in-run replay
    s.world.fault("/v1/refunds", { kind: "drop_response_after_commit" });
    const first = await s.run();
    expect(outcomes(first.receipts)).toMatchObject({ refund_001: "unknown_outcome" });

    const second = await s.run(); // restart: same journal, same world
    expect(second.state).toBe("completed");
    const all = Object.fromEntries(
      s.journal.receipts
        .filter((r) => r.outcome === "confirmed")
        .map((r) => [r.actionId, r.outcome]),
    );
    expect(all).toEqual(Object.fromEntries(bundle.expected.map((e) => [e.actionId, e.outcome])));
    expect(s.world.refunds.filter((r) => r.charge === "ch_fixture_001")).toHaveLength(1);
    expect(await states(s, "refund_001")).toEqual([["reconciled", null]]);
    const refund = s.world.refunds.find((r) => r.charge === "ch_fixture_001");
    expect(s.world.tickets.get("5531")?.comments.at(-1)?.body).toContain(refund?.id);
  });

  it("a crash right after dispatch (attempt left dispatched) is reconciled on restart", async () => {
    const s = setup(happyPathBundle());
    s.journal.failNextSettle = true; // the refund applies, then the process dies before settling
    await s.run();
    expect(await states(s, "refund_001")).toEqual([["dispatched", null]]);
    const second = await s.run();
    expect(outcomes(second.receipts)).toMatchObject({
      refund_001: "confirmed",
      note_001: "confirmed",
    });
    expect(await states(s, "refund_001")).toEqual([["reconciled", null]]);
    expect(s.world.refunds.filter((r) => r.charge === "ch_fixture_001")).toHaveLength(1);
  });

  it("a read showing the send never landed re-sends once the window has passed", async () => {
    const s = setup(happyPathBundle());
    s.deps.retry = { maxAttempts: 1 };
    s.world.fault("/v1/refunds", { kind: "server_error" }); // no effect, outcome unknown
    await s.run();
    advance(s, 61_000);
    const second = await s.run();
    expect(outcomes(second.receipts)).toMatchObject({ refund_001: "confirmed" });
    expect(await states(s, "refund_001")).toEqual([
      ["rejected", null],
      ["confirmed", 200],
    ]);
    expect(s.world.refunds.filter((r) => r.charge === "ch_fixture_001")).toHaveLength(1);
  });

  it("doesn't trust 'not applied' while the send is recent (it could still land)", async () => {
    const s = setup(happyPathBundle());
    s.deps.retry = { maxAttempts: 1 };
    s.world.fault("/v1/refunds", { kind: "server_error" });
    await s.run();
    advance(s, 5_000);
    const second = await s.run();
    expect(outcomes(second.receipts)).toMatchObject({ refund_001: "held" });
    expect(s.world.refunds.filter((r) => r.charge === "ch_fixture_001")).toHaveLength(0);
  });

  it("finds a lost note by its operation marker and never appends it twice", async () => {
    const s = setup(happyPathBundle());
    dropZendesk(s, '"comment"');
    const first = await s.run();
    expect(outcomes(first.receipts)).toMatchObject({ note_001: "unknown_outcome" });
    const second = await s.run();
    expect(outcomes(second.receipts)).toMatchObject({ note_001: "confirmed" });
    expect(s.world.tickets.get("5531")?.comments).toHaveLength(1);
  });

  it("keeps a missing non-idempotent note held even after the window", async () => {
    const s = setup(happyPathBundle());
    dropZendesk(s, '"comment"', false);
    await s.run();
    advance(s, 61_000);
    const second = await s.run();
    expect(outcomes(second.receipts)).toMatchObject({ note_001: "held" });
    expect(s.world.tickets.get("5531")?.comments).toHaveLength(0);
  });

  it("does not duplicate a delayed original note after a negative reconcile read", async () => {
    const s = setup(happyPathBundle());
    const dispatch = s.deps.providers.zendesk.dispatch;
    const pending: Array<() => Promise<unknown>> = [];
    s.deps.providers.zendesk.dispatch = async (req, ctx) => {
      if (
        pending.length === 0 &&
        req.path.includes("5531") &&
        JSON.parse(req.body).ticket.comment
      ) {
        pending.push(() => dispatch(req, ctx));
        return { kind: "unknown", error: "original request still pending" };
      }
      return dispatch(req, ctx);
    };
    await s.run();
    advance(s, 61_000);
    expect(outcomes((await s.run()).receipts)).toMatchObject({ note_001: "held" });
    expect(s.world.tickets.get("5531")?.comments).toHaveLength(0);
    await pending[0]?.();
    expect(outcomes((await s.run()).receipts)).toMatchObject({ note_001: "confirmed" });
    expect(s.world.tickets.get("5531")?.comments).toHaveLength(1);
  });

  it("holds legacy negative-read rejection rows for non-idempotent notes", async () => {
    const s = setup(happyPathBundle());
    dropZendesk(s, '"comment"', false);
    await s.run();
    const [attempt] = await s.journal.attemptsFor(s.hash, "note_001");
    if (!attempt) throw new Error("no note attempt");
    await s.journal.transition(attempt.id, "unknown_outcome", "rejected", { providerStatus: null });
    advance(s, 61_000);
    expect(outcomes((await s.run()).receipts)).toMatchObject({ note_001: "held" });
    expect(s.world.tickets.get("5531")?.comments).toHaveLength(0);
  });

  it("reconciles a lost patch by its fields", async () => {
    const s = setup(happyPathBundle());
    dropZendesk(s, '"safe_update"');
    await s.run();
    const second = await s.run();
    expect(outcomes(second.receipts)).toMatchObject({ patch_001: "confirmed" });
    expect(s.world.tickets.get("5531")?.priority).toBe("high");
  });

  it("holds a patch it can't tell apart: not ours, and the ticket moved since our read", async () => {
    const s = setup(happyPathBundle());
    dropZendesk(s, '"safe_update"', false);
    await s.run();
    s.world.teammateEdit("5531", "priority", "urgent");
    advance(s, 61_000);
    const second = await s.run();
    expect(outcomes(second.receipts)).toMatchObject({ patch_001: "held" });
    expect(s.world.tickets.get("5531")?.priority).toBe("urgent");
  });

  it("a failing reconcile read holds the step", async () => {
    const s = setup(happyPathBundle());
    s.deps.retry = { maxAttempts: 1 };
    s.world.fault("/v1/refunds", { kind: "drop_response_after_commit" });
    await s.run();
    s.deps.providers.stripe = {
      ...s.deps.providers.stripe,
      reconcile: async () => {
        throw new Error("read timed out");
      },
    };
    const second = await s.run();
    expect(outcomes(second.receipts)).toMatchObject({ refund_001: "held" });
    expect(s.world.refunds.filter((r) => r.charge === "ch_fixture_001")).toHaveLength(1);
  });

  it("a revision that changed an in-flight refund's amount is held, not handed the old refund", async () => {
    const s = setup(happyPathBundle());
    s.deps.retry = { maxAttempts: 1 };
    s.world.fault("/v1/refunds", { kind: "drop_response_after_commit" });
    await s.run(); // rev1's 4210 refund lands, response lost
    const rev2 = await addRevision(s, (m) => {
      const refund = m.actions.find((a) => a.id === "refund_001");
      if (refund?.kind === "stripe.refund.create") refund.args.amount.amountMinor = 4000;
    }).run();
    const receipt = rev2.receipts.find((r) => r.actionId === "refund_001");
    expect(receipt?.outcome).toBe("held");
    expect(receipt?.holdReason).toMatchObject({ kind: "approval_invalid" });
    expect(
      receipt?.holdReason && "detail" in receipt.holdReason && receipt.holdReason.detail,
    ).toMatch(/applied with different content/);
    expect(outcomes(rev2.receipts)).toMatchObject({ note_001: "skipped_dependency" });
    expect(
      s.world.refunds.filter((r) => r.charge === "ch_fixture_001").map((r) => r.amount),
    ).toEqual([4210]);
    expect(await states(s, "refund_001")).toEqual([["reconciled", null]]);
  });

  it("a revision that changed an in-flight note's text is held, and nothing is appended", async () => {
    const s = setup(happyPathBundle());
    dropZendesk(s, '"comment"'); // rev1's note lands, response lost
    await s.run();
    const rev2 = await addRevision(s, (m) => {
      const note = m.actions.find((a) => a.id === "note_001");
      if (note?.kind === "zendesk.ticket.appendPrivateNote") note.args.bindings.amountMinor = 4000;
    }).run();
    expect(outcomes(rev2.receipts)).toMatchObject({ note_001: "held" });
    expect(s.world.tickets.get("5531")?.comments).toHaveLength(1);
  });

  it("the original revision still finishes after another revision's run reconciled its refund", async () => {
    const s = setup(happyPathBundle());
    s.deps.retry = { maxAttempts: 1 };
    s.world.fault("/v1/refunds", { kind: "drop_response_after_commit" });
    await s.run(); // rev1: refund lands, response lost
    await addRevision(s, (m) => {
      const refund = m.actions.find((a) => a.id === "refund_001");
      if (refund?.kind === "stripe.refund.create") refund.args.amount.amountMinor = 4000;
    }).run(); // rev2 (changed) reconciles rev1's attempt and holds

    const again = await s.run(); // rev1 again: its refund is read back, its note goes out
    expect(outcomes(again.receipts)).toMatchObject({
      refund_001: "confirmed",
      note_001: "confirmed",
    });
    expect(again.receipts.find((r) => r.actionId === "refund_001")?.limitations.join(" ")).toMatch(
      /read back, not re-sent/,
    );
    const refunds = s.world.refunds.filter((r) => r.charge === "ch_fixture_001");
    expect(refunds.map((r) => r.amount)).toEqual([4210]);
    expect(s.world.tickets.get("5531")?.comments.at(-1)?.body).toContain(refunds[0]?.id);
    expect(s.world.tickets.get("5531")?.comments).toHaveLength(1);
  });

  it("an identical revision over an in-flight refund confirms it by reading", async () => {
    const s = setup(happyPathBundle());
    s.deps.retry = { maxAttempts: 1 };
    s.world.fault("/v1/refunds", { kind: "drop_response_after_commit" });
    await s.run();
    const rev2 = await addRevision(s).run();
    expect(outcomes(rev2.receipts)).toMatchObject({
      refund_001: "confirmed",
      note_001: "confirmed",
    });
    expect(s.world.refunds.filter((r) => r.charge === "ch_fixture_001")).toHaveLength(1);
  });

  it("writes an in-run replay's reconciled marks in the same atomic settle", async () => {
    const s = setup(happyPathBundle());
    s.world.fault("/v1/refunds", { kind: "server_error" });
    let n = 0;
    const settle = s.journal.settle.bind(s.journal);
    s.journal.settle = async (step) => {
      if (step.receipt.actionId === "refund_001" && n++ === 0)
        throw new Error("journal down (injected)");
      return settle(step);
    };
    await s.run();
    // Nothing of the failed settle landed: the first send is still unknown, not "reconciled".
    expect(await states(s, "refund_001")).toEqual([
      ["unknown_outcome", null],
      ["dispatched", null],
    ]);
    const second = await s.run();
    expect(outcomes(second.receipts)).toMatchObject({ refund_001: "confirmed" });
    expect(await states(s, "refund_001")).toEqual([
      ["reconciled", null],
      ["reconciled", null],
    ]);
    expect(s.world.refunds.filter((r) => r.charge === "ch_fixture_001")).toHaveLength(1);
  });
});

describe("cancellation and lock order (T3.6)", () => {
  it("a run cancelled before admission sends nothing", async () => {
    const s = setup(happyPathBundle());
    s.store.cancelled.add(RUN);
    const result = await s.run();
    expect(result).toMatchObject({ state: "cancelled", refusal: RUN_CANCELLED, receipts: [] });
    expect(s.world.effects).toEqual([]);
  });

  it("a cancel mid-run stops before the next action; what happened keeps its receipt", async () => {
    const s = setup(happyPathBundle());
    const stripe = s.deps.providers.stripe;
    s.deps.providers.stripe = {
      ...stripe,
      dispatch: async (req, ctx) => {
        const res = await stripe.dispatch(req, ctx);
        s.store.cancelled.add(RUN); // someone cancels right after the first refund lands
        return res;
      },
    };
    const result = await s.run();
    expect(result.state).toBe("cancelled");
    expect(outcomes(result.receipts)).toEqual({ refund_001: "confirmed" });
    expect(s.world.refunds).toHaveLength(1);
    expect(s.world.tickets.get("5531")?.comments).toHaveLength(0);
    expect(s.journal.events.some((e) => e.type === "run.cancelled")).toBe(true);
  });

  it("a cancel during a 429 backoff stops the retry", async () => {
    const s = setup(happyPathBundle());
    s.world.fault("/v1/refunds", {
      kind: "reject",
      status: 429,
      retryable: true,
      retryAfterMs: 1000,
    });
    s.deps.sleep = async () => {
      s.store.cancelled.add(RUN);
    };
    const result = await s.run();
    expect(result.state).toBe("cancelled");
    expect(result.receipts).toEqual([]);
    expect((await s.journal.attemptsFor(s.hash, "refund_001")).map((a) => a.state)).toEqual([
      "rejected",
    ]);
    expect(s.world.refunds).toHaveLength(0);
  });

  it("a cancel before an idempotent replay leaves the earlier unknown send unknown, unsent", async () => {
    const s = setup(happyPathBundle());
    s.world.fault("/v1/refunds", { kind: "drop_response_after_commit" });
    s.deps.sleep = async () => {
      s.store.cancelled.add(RUN);
    };
    const result = await s.run();
    expect(result.state).toBe("cancelled");
    const receipt = result.receipts.find((r) => r.actionId === "refund_001");
    expect(receipt?.outcome).toBe("unknown_outcome");
    expect(receipt?.limitations.join(" ")).toMatch(/run cancelled/);
    expect(s.world.refunds).toHaveLength(1); // the lost send did land; it was not sent again
  });

  it("cancelling a run whose refund was sent but never settled still records the refund", async () => {
    const s = setup(happyPathBundle());
    s.journal.failNextSettle = true; // the refund lands, then the worker dies before settling
    await s.run();
    expect((await s.journal.attemptsFor(s.hash, "refund_001")).map((a) => a.state)).toEqual([
      "dispatched",
    ]);
    s.store.cancelled.add(RUN); // the user sees a stuck run and cancels it
    const result = await s.run();
    expect(result.state).toBe("cancelled");
    expect(outcomes(result.receipts)).toEqual({ refund_001: "confirmed" });
    expect(result.receipts[0]?.limitations.join(" ")).toMatch(/found by reading/);
    expect(s.world.refunds).toHaveLength(1);
    expect(s.world.tickets.get("5531")?.comments).toHaveLength(0); // nothing new was sent
  });

  it("a cancelled run never re-sends an in-flight note it can't find", async () => {
    const s = setup(happyPathBundle());
    const zendesk = s.deps.providers.zendesk;
    s.deps.providers.zendesk = {
      ...zendesk,
      dispatch: async (req, ctx) =>
        req.body.includes('"comment"')
          ? { kind: "unknown", error: "lost before it landed (injected)" }
          : zendesk.dispatch(req, ctx),
    };
    await s.run();
    s.store.cancelled.add(RUN);
    (s.deps.clock as FakeClock).advance(3_600_000);
    const result = await s.run();
    expect(result.state).toBe("cancelled");
    expect(outcomes(result.receipts)).toEqual({ note_001: "held", note_002: "held" });
    expect(s.world.tickets.get("5531")?.comments).toHaveLength(0);
  });

  it("repeated read-only passes over an unresolved note add no duplicate holds", async () => {
    const s = setup(happyPathBundle());
    const zendesk = s.deps.providers.zendesk;
    s.deps.providers.zendesk = {
      ...zendesk,
      dispatch: async (req, ctx) =>
        req.body.includes('"comment"')
          ? { kind: "unknown", error: "lost before it landed (injected)" }
          : zendesk.dispatch(req, ctx),
    };
    await s.run();
    s.store.cancelled.add(RUN);
    for (let i = 0; i < 3; i++) await s.run();
    const holds = s.journal.receipts.filter(
      (r) => r.outcome === "held" && r.actionId === "note_001",
    );
    expect(holds).toHaveLength(1);
    expect((await s.journal.attemptsFor(s.hash, "note_001")).map((a) => a.state)).toEqual([
      "unknown_outcome",
    ]);
  });

  it("a cancelled run never closes an unfound refund as rejected (no replay will follow)", async () => {
    const s = setup(happyPathBundle());
    s.deps.retry = { maxAttempts: 1 };
    s.world.fault("/v1/refunds", { kind: "server_error" }); // no effect; outcome unknown
    await s.run();
    s.store.cancelled.add(RUN);
    (s.deps.clock as FakeClock).advance(3_600_000);
    const result = await s.run();
    expect(outcomes(result.receipts)).toMatchObject({ refund_001: "held" });
    expect((await s.journal.attemptsFor(s.hash, "refund_001")).map((a) => a.state)).toEqual([
      "unknown_outcome",
    ]);
    expect(s.world.refunds).toHaveLength(1); // only case 002's refund; refund_001 never re-sent
  });

  it("a delivery whose grant has since expired defers to a running delivery instead of failing", async () => {
    const s = setup(happyPathBundle(), { expiresAt: "2026-10-21T11:59:00.000Z" });
    const release = await s.store.lockPlan(s.manifest.orgId, s.manifest.planId);
    try {
      const result = await s.run();
      expect(result).toMatchObject({ refusal: PLAN_LOCKED });
      expect(result.state).not.toBe("failed");
    } finally {
      await release?.();
    }
    // Without the lock held, the same expired grant is refused (nothing sent either way).
    expect((await s.run()).refusal).toMatch(/expired/);
    expect(s.world.effects).toEqual([]);
  });
});

describe("bounded concurrency across cases (T3.7)", () => {
  /**
   * The happy bundle widened to `n` customer cases, each with its own customer, charge, ticket,
   * evidence and customer query, as the planner records them. With `shareTicket`, the extra cases
   * all write case_001's ticket.
   */
  function wideBundle(n: number, shareTicket = false): ReplayBundle {
    const bundle = happyPathBundle();
    const m = bundle.manifest;
    const byId = <T extends { id: string }>(list: T[], id: string) => {
      const found = list.find((x) => x.id === id);
      if (!found) throw new Error(`fixture has no ${id}`);
      return found;
    };
    const chargeObs = byId(m.observations, "obs_charge_001");
    const ticketObs = byId(m.observations, "obs_ticket_001");
    const query = byId(m.queryObservations, "q_charges_001");
    const template = m.actions.filter((a) => a.caseId === "case_001");
    for (let k = 3; k <= n; k++) {
      const tag = String(k).padStart(3, "0");
      const customer = `cus_fixture_${tag}`;
      const chargeId = `ch_fixture_${tag}`;
      const ticketId = shareTicket ? "5531" : `55${tag}`;
      const charge = { ...chargeObs.projection, id: chargeId, customer };
      m.observations.push({
        ...chargeObs,
        id: `obs_charge_${tag}`,
        entity: { ...chargeObs.entity, id: chargeId },
        projection: charge,
        fingerprint: fingerprint(charge),
      });
      if (!shareTicket) {
        const ticket = { ...ticketObs.projection, id: ticketId, requester_id: customer };
        m.observations.push({
          ...ticketObs,
          id: `obs_ticket_${tag}`,
          entity: { ...ticketObs.entity, id: ticketId },
          projection: ticket,
          fingerprint: fingerprint(ticket),
        });
      }
      const projections = { [chargeId]: charge };
      m.queryObservations.push({
        ...query,
        id: `q_charges_${tag}`,
        predicate: { ...query.predicate, customerId: customer } as typeof query.predicate,
        matchingIds: [chargeId],
        projections,
        fingerprint: fingerprint({ matchingIds: [chargeId], projections }),
      });
      for (const a of template) {
        const copy = structuredClone(a);
        copy.id = a.id.replace("001", tag);
        copy.caseId = `case_${tag}`;
        copy.obligationId = `obl_overcharge_${tag}`;
        copy.dependsOn = a.dependsOn.map((d) => d.replace("001", tag));
        copy.evidence = a.evidence.map((e) =>
          e === "obs_ticket_001" && shareTicket ? e : e.replace("001", tag),
        );
        copy.queryEvidence = a.queryEvidence.map((q) => q.replace("001", tag));
        if (copy.kind === "stripe.refund.create") copy.args.chargeId = chargeId;
        else copy.args.ticketId = ticketId;
        if (copy.kind === "zendesk.ticket.appendPrivateNote") {
          copy.args.bindings.refundId = {
            $ref: "result",
            stepId: `refund_${tag}`,
            path: "refund.id",
          };
        }
        bundle.manifest.actions.push(copy);
      }
    }
    return bundle;
  }
  /** The setup, with T4's real read guard on the same providers the executor sends through. */
  function guarded(bundle: ReplayBundle) {
    const s = setup(bundle);
    s.deps.guard = createReadGuard({
      providers: s.deps.providers,
      worlds: s.deps.worlds,
      clock: s.deps.clock,
    });
    return s;
  }
  /** Count how many sends are on the wire at once, per vendor path. */
  function track(s: ReturnType<typeof setup>) {
    const live = { now: 0, max: 0, perTicket: new Map<string, number>(), maxPerTicket: 0 };
    for (const vendor of ["stripe", "zendesk"] as const) {
      const port = s.deps.providers[vendor];
      s.deps.providers[vendor] = {
        ...port,
        dispatch: async (req, ctx) => {
          live.now += 1;
          live.max = Math.max(live.max, live.now);
          const t = /tickets\/(\d+)/.exec(req.path)?.[1];
          if (t) {
            const c = (live.perTicket.get(t) ?? 0) + 1;
            live.perTicket.set(t, c);
            live.maxPerTicket = Math.max(live.maxPerTicket, c);
          }
          await new Promise((r) => setTimeout(r, 5));
          try {
            return await port.dispatch(req, ctx);
          } finally {
            live.now -= 1;
            if (t) live.perTicket.set(t, (live.perTicket.get(t) ?? 1) - 1);
          }
        },
      };
    }
    return live;
  }

  it("applies independent cases at once, never more than the limit, with the sequential results", async () => {
    const sequential = guarded(wideBundle(6));
    const expected = outcomes((await sequential.run()).receipts);

    const s = guarded(wideBundle(6));
    s.deps.caseConcurrency = 3;
    const live = track(s);
    const result = await s.run();
    expect(result.state).toBe("completed");
    expect(outcomes(result.receipts)).toEqual(expected);
    expect(live.max).toBeGreaterThan(1);
    expect(live.max).toBeLessThanOrEqual(3);
    expect(s.world.refunds).toHaveLength(6);
    // Each note names its own case's refund.
    for (let k = 1; k <= 6; k++) {
      const tag = String(k).padStart(3, "0");
      const ticket = k === 1 ? "5531" : k === 2 ? "5532" : `55${tag}`;
      const refund = s.world.refunds.find((r) => r.charge === `ch_fixture_${tag}`);
      expect(s.world.tickets.get(ticket)?.comments.at(-1)?.body).toContain(refund?.id);
    }
  });

  it("a case waiting out a 429 doesn't block the others", async () => {
    const s = guarded(wideBundle(4));
    s.deps.caseConcurrency = 4;
    s.world.fault("/v1/refunds", {
      kind: "reject",
      status: 429,
      retryable: true,
      retryAfterMs: 1000,
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let confirmedWhileWaiting = 0;
    s.deps.sleep = async () => {
      // Let the other cases run while this one "sleeps".
      await new Promise((r) => setTimeout(r, 30));
      confirmedWhileWaiting = s.journal.receipts.filter((r) => r.outcome === "confirmed").length;
      release();
    };
    const result = await Promise.all([s.run(), gate]).then(([r]) => r);
    expect(result.state).toBe("completed");
    expect(confirmedWhileWaiting).toBeGreaterThan(0);
  });

  it("cases that share a ticket never write to it at the same time", async () => {
    const s = guarded(wideBundle(5, true));
    s.deps.caseConcurrency = 5;
    const live = track(s);
    const result = await s.run();
    expect(result.state).toBe("completed");
    expect(live.maxPerTicket).toBe(1);
  });

  it("an unexpected error stops new actions in every case; the run reads honestly", async () => {
    const s = guarded(wideBundle(6));
    s.deps.caseConcurrency = 3;
    s.journal.failNextSettle = true; // the first settle throws
    const result = await s.run();
    expect(result.error).toMatch(/journal unavailable/);
    expect(["held", "partial"]).toContain(result.state);
    expect(s.world.refunds.length).toBeLessThan(6); // nobody kept starting new cases
  });

  it("a cancel stops every lane before its next action", async () => {
    const s = guarded(wideBundle(6));
    s.deps.caseConcurrency = 3;
    const stripe = s.deps.providers.stripe;
    let sends = 0;
    s.deps.providers.stripe = {
      ...stripe,
      dispatch: async (req, ctx) => {
        sends += 1;
        if (sends === 2) s.store.cancelled.add(RUN);
        return stripe.dispatch(req, ctx);
      },
    };
    const result = await s.run();
    expect(result.state).toBe("cancelled");
    expect(s.world.refunds.length).toBeLessThanOrEqual(3); // at most the sends already under way
  });

  it("a case citing another case's record as evidence runs with it: no false hold", async () => {
    const overlapping = () => {
      const b = wideBundle(4);
      const refund = b.manifest.actions.find((a) => a.id === "refund_003");
      refund?.evidence.push("obs_charge_001"); // case 3 also relies on case 1's charge
      return b;
    };
    expect(caseGroups(overlapping().manifest)).toHaveLength(3);
    const sequential = guarded(overlapping());
    const expected = outcomes((await sequential.run()).receipts);
    const s = guarded(overlapping());
    s.deps.caseConcurrency = 4;
    // Open the race: case 1's refund lands but settles slowly, while case 3's guard re-reads
    // case 1's charge in between. Without grouping, case 3 would see our own refund as drift.
    const stripe = s.deps.providers.stripe;
    s.deps.providers.stripe = {
      ...stripe,
      dispatch: async (req, ctx) => {
        const res = await stripe.dispatch(req, ctx);
        if (req.body.includes("ch_fixture_001")) await new Promise((r) => setTimeout(r, 80));
        return res;
      },
    };
    const guard = s.deps.guard;
    s.deps.guard = async (action, ctx) => {
      if (action.id === "refund_003") await new Promise((r) => setTimeout(r, 30));
      return guard ? guard(action, ctx) : null;
    };
    const result = await s.run();
    expect(outcomes(result.receipts)).toEqual(expected);
    expect(result.state).toBe("completed");
  });

  it("caseConcurrency 1 keeps the exact global order; a bad value falls back to 1", async () => {
    const s = guarded(wideBundle(3));
    s.deps.caseConcurrency = Number.NaN;
    const result = await s.run();
    expect(result.state).toBe("completed");
    expect(result.receipts.map((r) => r.actionId)).toEqual(
      topoOrder(s.manifest.actions).map((a) => a.id),
    );
  });

  it("groups cases that share a record or depend on each other", () => {
    const shared = wideBundle(4, true).manifest;
    expect(caseGroups(shared).map((g) => new Set(g.map((a) => a.caseId)).size)).toEqual([3, 1]);
    const independent = wideBundle(4).manifest;
    expect(caseGroups(independent)).toHaveLength(4);
    const crossDep = structuredClone(independent);
    const note = crossDep.actions.find((a) => a.id === "note_003");
    if (note) note.dependsOn.push("refund_004");
    expect(caseGroups(crossDep)).toHaveLength(3);
  });
});

describe("read-only passes read only the operational world (#121)", () => {
  /** refund_001's response is lost; then the workers are pointed at the planning world. */
  function lostThenMisconfigured() {
    const s = setup(happyPathBundle());
    s.deps.retry = { maxAttempts: 1 };
    const stripe = s.deps.providers.stripe;
    let lose = true;
    s.deps.providers.stripe = {
      ...stripe,
      dispatch: async (req, ctx) => {
        const res = await stripe.dispatch(req, ctx);
        if (!lose) return res;
        lose = false;
        return { kind: "unknown", error: "response lost (injected)" };
      },
    };
    let reads = 0;
    const misconfigure = () => {
      s.deps.worlds = { ...s.deps.worlds, stripe: { world: "planning", tenant: "test" } };
      s.deps.providers.stripe = {
        ...stripe,
        reconcile: async (...args) => {
          reads++;
          return stripe.reconcile(...args);
        },
      };
    };
    return { s, misconfigure, reads: () => reads };
  }

  it("a refused run never reads a misconfigured world", async () => {
    const { s, misconfigure, reads } = lostThenMisconfigured();
    expect(outcomes((await s.run()).receipts).refund_001).toBe("unknown_outcome");
    misconfigure();
    const result = await s.run();
    expect(result.refusal).toMatch(/configured for the planning world/);
    expect(reads()).toBe(0);
  });

  it("a run refused for a reason other than its grant reads back its lost send and sends nothing", async () => {
    const { s } = lostThenMisconfigured();
    expect(outcomes((await s.run()).receipts).refund_001).toBe("unknown_outcome");
    const effects = s.world.effects.length;
    s.deps.policies = []; // the plan's policy is no longer loaded: refused, grant still live
    const result = await s.run();
    expect(result.refusal).toMatch(/policy .* is not loaded/);
    expect(outcomes(result.receipts).refund_001).toBe("confirmed");
    expect(s.world.effects.length).toBe(effects);
    expect(s.journal.events.at(-1)?.type).toBe("run.finished");
  });

  it("a refused run whose lost send can't be read stays unresolved and says it stopped", async () => {
    const { s } = lostThenMisconfigured();
    await s.run();
    const effects = s.world.effects.length;
    const stripe = s.deps.providers.stripe;
    s.deps.providers.stripe = {
      ...stripe,
      reconcile: async () => {
        throw new Error("read unavailable (injected)");
      },
    };
    s.deps.policies = [];
    const result = await s.run();
    expect(result.unresolved).toBe(true);
    expect(s.journal.events.at(-1)).toMatchObject({
      type: "run.stopped",
      payload: { unresolved: true },
    });
    expect(s.world.effects.length).toBe(effects);
  });

  it("a cancelled run never reads a misconfigured world", async () => {
    const { s, misconfigure, reads } = lostThenMisconfigured();
    await s.run();
    s.store.cancelled.add(RUN);
    misconfigure();
    const result = await s.run();
    expect(result.state).toBe("cancelled");
    expect(reads()).toBe(0);
  });
});

describe("read back each write before confirming it (T3.8)", () => {
  /** Replace stripe's reconcile for the first refund read-back only. */
  function stripeRead(s: ReturnType<typeof setup>, read: ProviderPort["reconcile"]) {
    const stripe = s.deps.providers.stripe;
    let first = true;
    s.deps.providers.stripe = {
      ...stripe,
      reconcile: async (attempt, action, world) => {
        if (first && action.id === "refund_001") {
          first = false;
          return read(attempt, action, world);
        }
        return stripe.reconcile(attempt, action, world);
      },
    };
  }
  const receiptOf = (r: { receipts: { actionId: string }[] }, id: string) =>
    r.receipts.find((x) => x.actionId === id) as (typeof r.receipts)[number] & {
      outcome: string;
      limitations: string[];
      observedEffect: Record<string, unknown>;
      holdReason: unknown;
    };

  it("confirms each write only once a read finds it, and records what was read", async () => {
    const s = setup(happyPathBundle());
    const result = await s.run();
    for (const id of ["refund_001", "patch_001", "note_001", "refund_002"]) {
      expect(receiptOf(result, id)).toMatchObject({
        outcome: "confirmed",
        limitations: ["read back from the provider after the write"],
      });
    }
    expect(receiptOf(result, "refund_001").observedEffect).toMatchObject({
      "refund.status": "succeeded",
      "refund.amount": 4210,
      charge: "ch_fixture_001",
    });
    expect(receiptOf(result, "patch_001").observedEffect).toMatchObject({ priority: "high" });
  });

  it("holds a write the provider confirmed but a read-back can't find; a later run reads it again", async () => {
    const s = setup(happyPathBundle());
    stripeRead(s, async () => ({ kind: "not_applied" }));
    const first = await s.run();
    expect(receiptOf(first, "refund_001")).toMatchObject({
      outcome: "held",
      holdReason: { kind: "unresolved_outcome" },
      limitations: [expect.stringMatching(/confirmed the write, but a read-back doesn't find/)],
    });
    expect(receiptOf(first, "note_001").outcome).toBe("skipped_dependency");
    expect(first.state).toBe("partial");

    const second = await s.run();
    expect(outcomes(second.receipts)).toMatchObject({
      refund_001: "confirmed",
      note_001: "confirmed",
    });
    expect(s.world.refunds.filter((r) => r.charge === "ch_fixture_001")).toHaveLength(1);
  });

  it("holds a refund whose read-back doesn't match the approved refund", async () => {
    const s = setup(happyPathBundle());
    const stripe = s.deps.providers.stripe;
    stripeRead(s, async (attempt, action, world) => {
      const real = await stripe.reconcile(attempt, action, world);
      return real.kind === "applied"
        ? { ...real, effect: { ...real.effect, "refund.amount": 9999 } }
        : real;
    });
    const result = await s.run();
    expect(receiptOf(result, "refund_001")).toMatchObject({
      outcome: "held",
      observedEffect: { read: { "refund.amount": 9999 } },
      limitations: [expect.stringMatching(/doesn't match the approved refund/)],
    });
  });

  it("keeps the write response when the read-back fails, and says so", async () => {
    const s = setup(happyPathBundle());
    stripeRead(s, async () => {
      throw new Error("stripe read unavailable (injected)");
    });
    const result = await s.run();
    expect(receiptOf(result, "refund_001")).toMatchObject({
      outcome: "confirmed",
      limitations: [
        "effect taken from the write response; read-back inconclusive: read failed: stripe read unavailable (injected)",
      ],
    });
    expect(receiptOf(result, "note_001").outcome).toBe("confirmed");
  });
});

describe("operation keys", () => {
  it("are stable across revisions, unique per action, and org-scoped", () => {
    const { manifest } = setup(happyPathBundle());
    const [refund, patch] = manifest.actions;
    if (!refund || !patch) throw new Error("fixture has no actions");
    const key = operationKey("org_demo", manifest.planId, refund);
    expect(operationKey("org_demo", manifest.planId, structuredClone(refund))).toBe(key);
    expect(operationKey("org_demo", manifest.planId, { ...refund, id: "refund_other" })).not.toBe(
      key,
    );
    expect(operationKey("org_other", manifest.planId, refund)).not.toBe(key);
  });

  it("two notes on the same ticket in one plan both apply", async () => {
    const bundle = happyPathBundle();
    const note = bundle.manifest.actions.find((a) => a.id === "note_001");
    if (!note) throw new Error("fixture has no note_001");
    bundle.manifest.actions.push({ ...structuredClone(note), id: "note_001b" });
    const s = setup(bundle);
    const result = await s.run();
    expect(result.state).toBe("completed");
    expect(s.world.tickets.get("5531")?.comments).toHaveLength(2);
  });
});

/** Decision 0011: where policy v3 asks for it, two different users must hold live grants. */
describe("two distinct approvers (T2.13)", () => {
  const V3 = policyV3 as BillingPolicy;
  /** The happy path, citing policy v3: its 125.00 CAD refund is above the dual-approval line. */
  function dual(over: Partial<ApprovalGrant> = {}) {
    const bundle = happyPathBundle();
    const s = setup(
      { ...bundle, manifest: { ...bundle.manifest, policies: [{ id: V3.id, version: 3 }] } },
      { actorUserId: "user_fin", roles: ["finance_lead"], ...over },
    );
    s.deps.policies = [POLICY, V3];
    return s;
  }
  const grant = (s: ReturnType<typeof dual>, id: string, over: Partial<ApprovalGrant>) => {
    const primary = s.store.grants.get(APPROVAL);
    if (!primary) throw new Error("setup has no grant");
    s.store.grants.set(id, { ...primary, id, ...over });
  };
  const refused = async (s: ReturnType<typeof dual>, detail: RegExp) => {
    const result = await s.run();
    expect(result.state).toBe("failed");
    expect(result.refusal).toMatch(detail);
    expect(s.world.effects).toEqual([]);
    expect(s.journal.attempts.size).toBe(0);
  };

  it("runs once a support lead and a different finance lead both hold live grants", async () => {
    const s = dual();
    grant(s, "grant_2", { actorUserId: "user_sup", roles: ["support_lead"] });
    const result = await s.run();
    expect(result.state).toBe("completed");
    expect(s.world.effects.length).toBeGreaterThan(0);
  });

  it("doesn't let one person holding both roles fill both seats", async () => {
    await refused(dual({ roles: ["support_lead", "finance_lead"] }), /still needed: support_lead/);
  });

  it("refuses with only the finance seat filled, and says the support seat is open", async () => {
    await refused(dual(), /still needed: support_lead/);
  });

  it("refuses two people who both hold only the same role", async () => {
    const s = dual({ roles: ["support_lead"] });
    grant(s, "grant_2", { actorUserId: "user_sup2", roles: ["support_lead"] });
    await refused(s, /still needed: finance_lead/);
  });

  it("refuses the same user signing twice", async () => {
    const s = dual({ roles: ["finance_lead", "support_lead"] });
    grant(s, "grant_2", { roles: ["support_lead"], actorSessionId: "sess_other" });
    await refused(s, /still needed/);
  });

  it.each<[string, Partial<ApprovalGrant>, RegExp]>([
    ["is revoked", { revokedAt: "2026-10-21T11:30:00.000Z" }, /still needed: support_lead/],
    ["has expired", { expiresAt: "2026-10-21T11:59:59.000Z" }, /still needed: support_lead/],
    ["is dated in the future", { grantedAt: "2026-10-21T12:00:01.000Z" }, /still needed/],
    ["is for another plan hash", { planHash: "f".repeat(64) }, /still needed/],
    ["is for another revision", { revision: 2 }, /still needed/],
    ["is for another org", { orgId: "org_other" }, /still needed/],
  ])("doesn't count a second grant that %s", async (_label, over, detail) => {
    const s = dual();
    grant(s, "grant_2", { actorUserId: "user_sup", roles: ["support_lead"], ...over });
    await refused(s, detail);
  });

  it("is blocked when the primary grant is revoked even though the other seat is filled", async () => {
    const s = dual({ revokedAt: "2026-10-21T11:30:00.000Z" });
    grant(s, "grant_2", { actorUserId: "user_sup", roles: ["support_lead"] });
    await refused(s, /revoked/);
  });

  it("fails closed when the store can't list grants", async () => {
    const s = dual();
    grant(s, "grant_2", { actorUserId: "user_sup", roles: ["support_lead"] });
    (s.store as { loadGrantsForPlanHash?: unknown }).loadGrantsForPlanHash = undefined;
    await refused(s, /can't list grants/);
  });

  it("changes nothing for a plan that cites policy v1", async () => {
    const s = setup(happyPathBundle());
    s.deps.policies = [POLICY, V3];
    expect((await s.run()).state).toBe("completed");
  });
});
