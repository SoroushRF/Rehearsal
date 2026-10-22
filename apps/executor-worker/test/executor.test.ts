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

    const second = await s.run();
    expect(outcomes(second.receipts)).toMatchObject({
      refund_001: "held",
      note_001: "skipped_dependency",
    });
    expect(s.world.refunds.filter((r) => r.charge === "ch_fixture_001")).toHaveLength(1);
  });

  it("an unreadable confirmed response is recorded as unknown_outcome", async () => {
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
