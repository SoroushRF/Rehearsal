import type { ApprovalGrant, PlanManifest, ReplayBundle } from "@rehearsal/contracts";
import {
  type BillingPolicyV1,
  type ExecutorDeps,
  executeRun,
  operationKey,
  type ProviderPort,
  planHash,
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
    expect(s.journal.events.at(-1)?.type).toBe("run.finished");

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

  it("re-sends a note that never landed, once, after the window", async () => {
    const s = setup(happyPathBundle());
    dropZendesk(s, '"comment"', false);
    await s.run();
    advance(s, 61_000);
    const second = await s.run();
    expect(outcomes(second.receipts)).toMatchObject({ note_001: "confirmed" });
    expect(s.world.tickets.get("5531")?.comments).toHaveLength(1);
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
