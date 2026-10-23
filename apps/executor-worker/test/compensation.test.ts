import type { ReplayBundle } from "@rehearsal/contracts";
import {
  type BillingPolicyV1,
  createCompensator,
  createReadGuard,
  type DispatchResult,
  type ExecutorDeps,
  executeRun,
  operationMarker,
  type ProviderPort,
  planHash,
} from "@rehearsal/core";
import {
  FakeClock,
  happyPathBundle,
  MemoryApplyStore,
  MemoryJournal,
  teammateConflictBundle,
  worldFromManifest,
} from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import policy from "../../../scenarios/billing/policy.v1.json" with { type: "json" };

const RUN = "run_1";
const APPROVAL = "grant_1";
const TICKET = "/api/v2/tickets/5532.json";

/** One approved bundle on an identical fake operational world, with guard and compensation. */
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
  const grant = {
    id: APPROVAL,
    orgId: manifest.orgId,
    planId: manifest.planId,
    revision: 1,
    planHash: hash,
    actorUserId: "user_finance",
    actorSessionId: "sess_1",
    roles: ["support_lead" as const, "finance_lead" as const],
    grantedAt: "2026-10-21T11:00:00.000Z",
    expiresAt: "2026-10-21T13:00:00.000Z",
    revokedAt: null,
  };
  store.grants.set(APPROVAL, grant);
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
  const journal = new MemoryJournal();
  const deps: ExecutorDeps = {
    store,
    journal,
    clock,
    providers,
    worlds,
    policies: [policy as BillingPolicyV1],
    newId: (prefix: string) => `${prefix}_${++n}`,
    guard: createReadGuard({ providers, worlds, clock }),
    compensate: createCompensator({ providers, worlds, clock }),
  };
  const job = {
    orgId: manifest.orgId,
    runId: RUN,
    planId: manifest.planId,
    revision: 1,
    planHash: hash,
  };
  /** Ticket writes sent to the world (forward patches, notes and undos), in order. */
  const ticketWrites = (path = TICKET) => world.effects.filter((e) => e.path === path).length;
  /** Store revision 2 (edited by `change`) with its own run and grant, like a re-approval. */
  const addRevision = (change: (m: typeof manifest) => void = () => {}) => {
    const rev2 = structuredClone({ ...manifest, revision: 2, parentRevision: 1 });
    change(rev2);
    const hash2 = planHash(rev2);
    store.plans.set(`${manifest.planId}@2`, { planHash: hash2, manifest: rev2 });
    store.runs.set("run_2", {
      planId: manifest.planId,
      revision: 2,
      planHash: hash2,
      approvalId: "grant_2",
    });
    store.grants.set("grant_2", { ...grant, id: "grant_2", revision: 2, planHash: hash2 });
    return {
      hash: hash2,
      run: () => executeRun({ ...job, runId: "run_2", revision: 2, planHash: hash2 }, deps),
    };
  };
  return {
    world,
    store,
    grant,
    journal,
    providers,
    hash,
    ticketWrites,
    addRevision,
    deps,
    run: () => executeRun(job, deps),
  };
}

type Setup = ReturnType<typeof setup>;

/**
 * Replay the bundle's `fail_step` and `teammate_field_edit` perturbations on Zendesk dispatches.
 * A failed step is refused with a 422 and never reaches the world; an edit lands right after the
 * step it names. `afterFail` runs once, right after the first failed step.
 */
function replay(s: Setup, bundle: ReplayBundle, afterFail: () => void = () => {}) {
  const fail = new Set(
    bundle.perturbations.flatMap((p) => (p.kind === "fail_step" ? [p.stepId] : [])),
  );
  const stepOf = (path: string, body: string) =>
    bundle.manifest.actions.find(
      (a) =>
        a.kind !== "stripe.refund.create" &&
        path === `/api/v2/tickets/${a.args.ticketId}.json` &&
        (a.kind === "zendesk.ticket.appendPrivateNote") ===
          (body.includes('"comment"') && !body.includes('"safe_update"')),
    )?.id;
  const zendesk = s.providers.zendesk;
  const dispatch = zendesk.dispatch;
  let failed = false;
  zendesk.dispatch = async (request, ctx): Promise<DispatchResult> => {
    const id = stepOf(request.path, request.body);
    const result: DispatchResult =
      id && fail.has(id)
        ? { kind: "rejected", status: 422, body: { error: "injected" }, retryable: false }
        : await dispatch(request, ctx);
    for (const p of bundle.perturbations) {
      if (p.kind === "teammate_field_edit" && p.at.afterStep === id) {
        s.world.teammateEdit(p.ticketId, p.field, p.value);
      }
    }
    if (id && fail.has(id) && !failed) {
      failed = true;
      afterFail();
    }
    return result;
  };
}

/** Latest outcome per action: compensation appends a receipt after the forward one. */
const outcomes = (receipts: { actionId: string; outcome: string }[]) =>
  Object.fromEntries(receipts.map((r) => [r.actionId, r.outcome]));

/** The conflict bundle without its teammate edit: the note still fails. */
function noteFails(): ReplayBundle {
  const bundle = teammateConflictBundle();
  bundle.perturbations = bundle.perturbations.filter((p) => p.kind === "fail_step");
  return bundle;
}

/** A second patch on 5532, depending on `patch_002`: priority high → urgent. */
function stackedPriority(bundle: ReplayBundle): ReplayBundle {
  const actions = bundle.manifest.actions;
  const patch = actions.find((a) => a.id === "patch_002");
  if (patch?.kind !== "zendesk.ticket.patchFields") throw new Error("no patch_002");
  actions.splice(actions.indexOf(patch) + 1, 0, {
    ...structuredClone(patch),
    id: "patch_002b",
    dependsOn: ["patch_002"],
    rationale: "Raise priority again while the remedy is in flight.",
    args: {
      ticketId: patch.args.ticketId,
      set: { priority: "urgent" },
      before: { priority: "high" },
    },
  });
  return bundle;
}

/** `patch_002` also sets status, with the given before values. */
function twoFields(bundle: ReplayBundle, before: { priority?: "normal"; status?: "open" }) {
  const patch = bundle.manifest.actions.find((a) => a.id === "patch_002");
  if (patch?.kind !== "zendesk.ticket.patchFields") throw new Error("no patch_002");
  patch.args = { ticketId: "5532", set: { priority: "high", status: "pending" }, before };
  return bundle;
}

/** Comments on 5532 other than an undo's attribution marker. */
const noteComments = (s: Setup) =>
  (s.world.tickets.get("5532")?.comments ?? []).filter(
    (c) => !/^\[rehearsal-op:[^\]]+\]$/.test(c.body),
  );

/** Every receipt `patch_002` has under one plan hash. */
const patchReceipts = async (s: Setup, hash: string) =>
  (await s.journal.receiptsFor(hash)).filter((r) => r.actionId === "patch_002");

describe("conditional compensation", () => {
  it("passes the teammate-conflict bundle: their edit survives and nothing is written", async () => {
    const bundle = teammateConflictBundle();
    const s = setup(bundle);
    replay(s, bundle);
    const result = await s.run();

    expect(result.error).toBeNull();
    expect(outcomes(result.receipts)).toEqual(
      Object.fromEntries(bundle.expected.map((e) => [e.actionId, e.outcome])),
    );
    expect(result.receipts.find((r) => r.outcome === "compensation_conflict")).toMatchObject({
      actionId: "patch_002",
      observedEffect: { priority: "urgent" },
      limitations: ["kept priority = urgent: changed by someone else", "nothing written"],
    });
    expect(result.state).toBe("partial");
    expect(s.world.tickets.get("5532")?.priority).toBe("urgent");
    // Only the forward patch reached the ticket; the refund stands.
    expect(s.ticketWrites()).toBe(1);
    expect(s.world.refunds.filter((r) => r.charge === "ch_fixture_002")).toHaveLength(1);
  });

  it("reverts our value with a stamp-guarded patch when nobody touched it", async () => {
    const bundle = noteFails();
    const s = setup(bundle);
    replay(s, bundle);
    const result = await s.run();

    expect(outcomes(result.receipts)).toMatchObject({
      refund_002: "confirmed",
      patch_002: "compensated",
      note_002: "rejected",
      patch_001: "confirmed",
      note_001: "confirmed",
    });
    // Append-only: the forward receipt is kept, the undo is a new one.
    expect(result.receipts.filter((r) => r.actionId === "patch_002").map((r) => r.outcome)).toEqual(
      ["confirmed", "compensated"],
    );
    expect(s.world.tickets.get("5532")?.priority).toBe("normal");
    expect(s.world.tickets.get("5531")?.priority).toBe("high");
    expect(s.world.refunds).toHaveLength(2);
    const undo = (await s.journal.attemptsFor(s.hash, "patch_002")).at(-1);
    expect(undo?.state).toBe("confirmed");
    expect(JSON.parse(undo?.request.body ?? "{}")).toMatchObject({
      ticket: { priority: "normal", safe_update: true },
    });
  });

  /** After the note fails, a teammate edits the ticket right after each compensation re-read. */
  const editAfterReread = (s: Setup, edit: () => void, times = Number.POSITIVE_INFINITY) => {
    let left = times;
    const observe = s.providers.zendesk.observe;
    s.providers.zendesk.observe = async (entity, ctx) => {
      const read = await observe(entity, ctx);
      if (entity.id === "5532" && left-- > 0) edit();
      return read;
    };
  };

  it("keeps an edit made between the compensation re-read and the undo (409)", async () => {
    const bundle = noteFails();
    const s = setup(bundle);
    replay(s, bundle, () =>
      editAfterReread(s, () => s.world.teammateEdit("5532", "priority", "low"), 1),
    );
    const result = await s.run();

    // The 409 re-reads: the field is no longer ours, so it's a conflict and nothing is written.
    expect(result.receipts.at(-1)).toMatchObject({
      actionId: "patch_002",
      outcome: "compensation_conflict",
      observedEffect: { priority: "low" },
    });
    expect(s.world.tickets.get("5532")?.priority).toBe("low");
  });

  it("undoes our field after a 409 caused by an edit to another field", async () => {
    const bundle = noteFails();
    const s = setup(bundle);
    replay(s, bundle, () =>
      editAfterReread(s, () => s.world.teammateEdit("5532", "status", "pending"), 1),
    );
    const result = await s.run();

    expect(result.receipts.at(-1)).toMatchObject({ actionId: "patch_002", outcome: "compensated" });
    expect(s.world.tickets.get("5532")).toMatchObject({ priority: "normal", status: "pending" });
    expect((await s.journal.attemptsFor(s.hash, "patch_002")).map((a) => a.state)).toEqual([
      "confirmed",
      "rejected",
      "confirmed",
    ]);
  });

  it("holds, not conflicts, when the ticket keeps changing but our value stays", async () => {
    const bundle = noteFails();
    const s = setup(bundle);
    replay(s, bundle, () =>
      editAfterReread(s, () => s.world.teammateEdit("5532", "status", "pending")),
    );
    const result = await s.run();

    expect(result.receipts.at(-1)).toMatchObject({
      actionId: "patch_002",
      outcome: "held",
      holdReason: { kind: "unsupported_protection" },
    });
    expect(s.world.tickets.get("5532")?.priority).toBe("high");
    expect(await s.journal.attemptsFor(s.hash, "patch_002")).toHaveLength(4);
  });

  it("copies the undo when another revision resolved this hash's lost patch and undid it", async () => {
    const bundle = noteFails();
    const s = setup(bundle);
    replay(s, bundle);
    s.world.fault(TICKET, { kind: "drop_response_after_commit" });
    await s.run();
    expect((await patchReceipts(s, s.hash)).map((r) => r.outcome)).toEqual(["unknown_outcome"]);

    const rev2 = s.addRevision();
    await rev2.run();
    expect((await patchReceipts(s, rev2.hash)).map((r) => r.outcome)).toEqual([
      "confirmed",
      "compensated",
    ]);

    await s.run();
    expect((await patchReceipts(s, s.hash)).map((r) => r.outcome)).toEqual([
      "unknown_outcome",
      "compensated",
    ]);
    expect(s.world.tickets.get("5532")?.priority).toBe("normal");
  });

  /** Happy path plus `note_002b` after `[refund_002, patch_002]`; the first note on 5532 is refused. */
  function dependentNote() {
    const bundle = happyPathBundle();
    const note = bundle.manifest.actions.find((a) => a.id === "note_002");
    if (!note) throw new Error("no note_002");
    bundle.manifest.actions.push({
      ...structuredClone(note),
      id: "note_002b",
      dependsOn: ["refund_002", "patch_002"],
    });
    const s = setup(bundle);
    const dispatch = s.providers.zendesk.dispatch;
    let firstNote = true;
    s.providers.zendesk.dispatch = async (request, ctx) => {
      if (request.path === TICKET && request.body.includes('"comment"') && firstNote) {
        firstNote = false;
        return { kind: "rejected", status: 422, body: { error: "injected" }, retryable: false };
      }
      return dispatch(request, ctx);
    };
    return s;
  }

  const noteReceipts = async (s: Setup, hash: string) =>
    (await s.journal.receiptsFor(hash))
      .filter((r) => r.actionId === "note_002b")
      .map((r) => r.outcome);

  it.each([
    ["a re-run of the same hash", (s: Setup) => s.run()],
    ["another revision", (s: Setup) => s.addRevision().run()],
  ])(
    "reconciles a lost dependent send after its predecessor was undone, under %s",
    async (_n, next) => {
      const s = dependentNote();
      // note_002b commits on the ticket, but its response is lost.
      const dispatch = s.providers.zendesk.dispatch;
      let notes = 0;
      s.providers.zendesk.dispatch = async (request, ctx) => {
        if (request.path === TICKET && request.body.includes('"comment"') && ++notes === 2) {
          s.world.fault(TICKET, { kind: "drop_response_after_commit" });
        }
        return dispatch(request, ctx);
      };
      const first = await s.run();
      expect(outcomes(first.receipts)).toMatchObject({
        note_002: "rejected",
        note_002b: "unknown_outcome",
        patch_002: "compensated",
      });

      const second = await next(s);
      expect(outcomes(second.receipts).note_002b).toBe("confirmed");
      expect(second.receipts.some((r) => r.outcome === "skipped_dependency")).toBe(false);
      expect(noteComments(s)).toHaveLength(1);
    },
  );

  it.each([
    ["a re-run of the same hash", (s: Setup) => s.run()],
    ["another revision", (s: Setup) => s.addRevision().run()],
  ])(
    "never sends a throttled dependent after its predecessor was undone, under %s",
    async (_n, next) => {
      const s = dependentNote();
      // note_002b is throttled past the retry cap: rejected, nothing written.
      const dispatch = s.providers.zendesk.dispatch;
      let notes = 0;
      s.providers.zendesk.dispatch = async (request, ctx) => {
        if (request.path === TICKET && request.body.includes('"comment"') && ++notes === 2) {
          s.world.fault(TICKET, {
            kind: "reject",
            status: 429,
            retryable: true,
            retryAfterMs: 60_000,
          });
        }
        return dispatch(request, ctx);
      };
      const first = await s.run();
      expect(outcomes(first.receipts)).toMatchObject({
        note_002: "rejected",
        note_002b: "rejected",
        patch_002: "compensated",
      });

      const second = await next(s);
      expect(outcomes(second.receipts).note_002b).toBe("skipped_dependency");
      expect(noteComments(s)).toHaveLength(0);
    },
  );

  /**
   * `refund_002` after `patch_002`, plus a second patch on 5532 that is refused (422) so case 2 is
   * compensated. The first refund send is lost: it reaches Stripe only when `lands` is set.
   */
  function lostRefundAfterUndo(lands: boolean) {
    const bundle = happyPathBundle();
    const actions = bundle.manifest.actions;
    const refund = actions.find((a) => a.id === "refund_002");
    const patch = actions.find((a) => a.id === "patch_002");
    if (!refund || patch?.kind !== "zendesk.ticket.patchFields") throw new Error("no case 2");
    refund.dependsOn = ["patch_002"];
    actions.push({
      ...structuredClone(patch),
      id: "patch_002_fail",
      args: { ...patch.args, set: { priority: "low" } },
    });
    const s = setup(bundle);
    s.deps.retry = { maxAttempts: 1 };
    s.deps.reconcileAfterMs = 0; // a negative read would permit an idempotent replay at once
    const zendesk = s.providers.zendesk.dispatch;
    s.providers.zendesk.dispatch = async (request, ctx) =>
      request.path === TICKET && request.body.includes('"low"')
        ? { kind: "rejected", status: 422, body: { error: "injected" }, retryable: false }
        : zendesk(request, ctx);
    const stripe = s.providers.stripe.dispatch;
    let lost = true;
    s.providers.stripe.dispatch = async (request, ctx) => {
      if (request.path === "/v1/refunds" && request.body.includes("ch_fixture_002") && lost) {
        lost = false;
        if (lands) await stripe(request, ctx);
        return { kind: "unknown", error: "transport failure" };
      }
      return stripe(request, ctx);
    };
    const refunds = () => s.world.refunds.filter((r) => r.charge === "ch_fixture_002").length;
    return { s, refunds };
  }

  it.each([
    ["a re-run of the same hash", (s: Setup) => s.run()],
    ["another revision", (s: Setup) => s.addRevision().run()],
  ])(
    "never sends a lost refund again once its predecessor was undone, under %s",
    async (_n, next) => {
      const { s, refunds } = lostRefundAfterUndo(false);
      const first = await s.run();
      expect(outcomes(first.receipts)).toMatchObject({
        patch_002: "compensated",
        patch_002_fail: "rejected",
        refund_002: "unknown_outcome",
      });
      expect(refunds()).toBe(0);

      // Past the reconcile age the read finds nothing: the refund is held, and nothing is sent.
      const second = await next(s);
      expect(second.error).toBeNull();
      expect(second.receipts.filter((r) => r.actionId === "refund_002")).toMatchObject([
        { outcome: "held", holdReason: { kind: "unresolved_outcome" } },
      ]);
      // Another pass of the same hash adds no duplicate hold and still sends nothing.
      const third = await next(s);
      expect(third.receipts.filter((r) => r.actionId === "refund_002")).toEqual([]);
      expect(refunds()).toBe(0);
      expect(s.world.tickets.get("5532")?.priority).toBe("normal");
    },
  );

  it.each([
    ["a re-run of the same hash", (s: Setup) => s.run()],
    ["another revision", (s: Setup) => s.addRevision().run()],
  ])(
    "records a lost refund that landed once its predecessor was undone, under %s",
    async (_n, next) => {
      const { s, refunds } = lostRefundAfterUndo(true);
      expect(outcomes((await s.run()).receipts).refund_002).toBe("unknown_outcome");
      const second = await next(s);
      expect(outcomes(second.receipts).refund_002).toBe("confirmed");
      expect(refunds()).toBe(1);
    },
  );

  it("still skips an applied dependent whose predecessor is held, not undone", async () => {
    const s = setup(happyPathBundle());
    await s.run();
    const rev2 = s.addRevision((m) => {
      const refund = m.actions.find((a) => a.id === "refund_001");
      if (refund?.kind === "stripe.refund.create") refund.args.amount.amountMinor = 4000;
    });
    const result = await rev2.run();
    expect(outcomes(result.receipts)).toMatchObject({
      refund_001: "held",
      note_001: "skipped_dependency",
    });
  });

  it("compensates again after a crash between 409 rounds", async () => {
    const bundle = noteFails();
    const s = setup(bundle);
    replay(s, bundle, () =>
      editAfterReread(s, () => s.world.teammateEdit("5532", "status", "pending"), 1),
    );
    // Round 1 gets a 409 and is marked rejected; the run dies before round 2 is journaled.
    const prepare = s.journal.prepareAttempt.bind(s.journal);
    let prepares = 0;
    s.journal.prepareAttempt = async (attempt) => {
      // The forward patch, then undo round 1, then round 2.
      if (attempt.actionId === "patch_002" && ++prepares === 3) {
        throw new Error("crash between rounds");
      }
      return prepare(attempt);
    };
    expect((await s.run()).error).toBe("compensation: crash between rounds");
    expect(s.world.tickets.get("5532")?.priority).toBe("high");

    const second = await s.run();
    expect(second.receipts.at(-1)).toMatchObject({ actionId: "patch_002", outcome: "compensated" });
    expect(s.world.tickets.get("5532")?.priority).toBe("normal");
  });

  it("keeps an applied note that depends on a patch undone since", async () => {
    const s = dependentNote();
    const first = await s.run();
    expect(outcomes(first.receipts)).toMatchObject({
      note_002: "rejected",
      note_002b: "confirmed",
      patch_002: "compensated",
    });

    await s.run();
    const rev2 = s.addRevision();
    await rev2.run();
    for (const hash of [s.hash, rev2.hash]) {
      expect(await noteReceipts(s, hash)).toEqual(["confirmed"]);
    }
    expect(noteComments(s)).toHaveLength(1);
  });

  it("reconciles a lost undo by reading the ticket and does not re-send it", async () => {
    const bundle = noteFails();
    const s = setup(bundle);
    replay(s, bundle, () => s.world.fault(TICKET, { kind: "drop_response_after_commit" }));
    const first = await s.run();
    expect(first.receipts.at(-1)).toMatchObject({
      actionId: "patch_002",
      outcome: "held",
      holdReason: { kind: "unresolved_outcome" },
    });
    expect(s.world.tickets.get("5532")?.priority).toBe("normal");
    const writes = s.ticketWrites();

    await s.run();
    expect((await patchReceipts(s, s.hash)).at(-1)).toMatchObject({
      outcome: "compensated",
      limitations: [
        expect.stringMatching(/outcome of undo attempt .+ found by reading the provider/),
      ],
    });
    expect(s.ticketWrites()).toBe(writes);

    // Settled: a further run adds nothing.
    await s.run();
    expect(await patchReceipts(s, s.hash)).toHaveLength(3);
  });

  it("sends a fresh undo once a read shows the lost one never landed", async () => {
    const bundle = noteFails();
    const s = setup(bundle);
    replay(s, bundle, () => s.world.fault(TICKET, { kind: "server_error" }));
    const first = await s.run();
    expect(first.receipts.at(-1)).toMatchObject({
      actionId: "patch_002",
      outcome: "held",
      holdReason: { kind: "unresolved_outcome" },
    });
    expect(s.world.tickets.get("5532")?.priority).toBe("high");
    const writes = s.ticketWrites();

    // Too soon to be sure the first undo isn't still landing.
    const second = await s.run();
    expect(second.receipts.some((r) => r.actionId === "patch_002")).toBe(false);
    expect(s.ticketWrites()).toBe(writes);
    expect(s.world.tickets.get("5532")?.priority).toBe("high");

    (s.deps.clock as FakeClock).advance(60_000);
    const third = await s.run();
    expect(third.receipts.at(-1)).toMatchObject({ actionId: "patch_002", outcome: "compensated" });
    expect(s.ticketWrites()).toBe(writes + 1);
    expect(s.world.tickets.get("5532")?.priority).toBe("normal");
  });

  it("keeps a manual hold when a read shows only part of a lost undo landed", async () => {
    const bundle = twoFields(noteFails(), { priority: "normal" });
    const s = setup(bundle);
    replay(s, bundle, () => s.world.fault(TICKET, { kind: "drop_response_after_commit" }));
    await s.run();
    const writes = s.ticketWrites();

    await s.run();
    expect((await patchReceipts(s, s.hash)).at(-1)).toMatchObject({
      outcome: "held",
      holdReason: { kind: "unsupported_protection" },
    });
    expect(s.ticketWrites()).toBe(writes);
    expect(s.world.tickets.get("5532")).toMatchObject({ priority: "normal", status: "pending" });
  });

  it("does not record a lost undo as compensated when someone else restored the value", async () => {
    const bundle = noteFails();
    const s = setup(bundle);
    replay(s, bundle, () => s.world.fault(TICKET, { kind: "server_error" }));
    await s.run();
    expect(s.world.tickets.get("5532")?.priority).toBe("high");
    s.world.teammateEdit("5532", "priority", "normal");
    const writes = s.ticketWrites();

    await s.run();
    expect((await patchReceipts(s, s.hash)).some((r) => r.outcome === "compensated")).toBe(false);
    expect(s.ticketWrites()).toBe(writes);
    expect(s.world.tickets.get("5532")?.priority).toBe("normal");
    expect(s.world.tickets.get("5532")?.comments).toHaveLength(0);
  });

  it("does not call the patch confirmed when the fresh undo does not finish", async () => {
    const bundle = noteFails();
    const s = setup(bundle);
    replay(s, bundle, () => s.world.fault(TICKET, { kind: "server_error" }));
    await s.run();
    (s.deps.clock as FakeClock).advance(60_000);
    const prepare = s.journal.prepareAttempt.bind(s.journal);
    s.journal.prepareAttempt = async (attempt) => {
      if (attempt.actionId === "patch_002" && attempt.attemptNo > 1) {
        throw new Error("fresh undo failed");
      }
      return prepare(attempt);
    };

    const third = await s.run();
    expect(third.error).toBe("compensation: fresh undo failed");
    expect(third.state).not.toBe("completed");
    expect((await patchReceipts(s, s.hash)).at(-1)).toMatchObject({
      outcome: "held",
      holdReason: { kind: "unresolved_outcome" },
    });
    const undo = (await s.journal.attemptsFor(s.hash, "patch_002")).find((a) =>
      a.request.body.includes("rehearsal-op"),
    );
    expect(undo?.state).toBe("unknown_outcome");
    expect(s.world.tickets.get("5532")?.priority).toBe("high");
  });

  it("holds a lost undo when the ticket changed to something the read can't settle", async () => {
    const bundle = noteFails();
    const s = setup(bundle);
    replay(s, bundle, () => s.world.fault(TICKET, { kind: "drop_response_after_commit" }));
    await s.run();
    s.world.teammateEdit("5532", "priority", "urgent");
    const writes = s.ticketWrites();

    const second = await s.run();
    expect(second.receipts.some((r) => r.actionId === "patch_002")).toBe(false);
    expect(s.ticketWrites()).toBe(writes);
    expect(s.world.tickets.get("5532")?.priority).toBe("urgent");
  });

  it("holds a refused undo once and never re-sends it", async () => {
    const bundle = noteFails();
    const s = setup(bundle);
    replay(s, bundle, () =>
      s.world.fault(TICKET, { kind: "reject", status: 422, retryable: false }),
    );
    const first = await s.run();
    expect(first.receipts.at(-1)).toMatchObject({
      actionId: "patch_002",
      outcome: "held",
      holdReason: {
        kind: "unsupported_protection",
        detail: "undo refused with 422; nothing written",
      },
    });
    const second = await s.run();
    expect(second.receipts.some((r) => r.actionId === "patch_002")).toBe(false);
    expect(s.world.tickets.get("5532")?.priority).toBe("high");
  });

  it("supersedes an undo that was prepared but never sent", async () => {
    const bundle = noteFails();
    const s = setup(bundle);
    replay(s, bundle);
    const transition = s.journal.transition.bind(s.journal);
    let crashed = false;
    s.journal.transition = async (id, from, to, patch) => {
      if (
        !crashed &&
        from === "prepared" &&
        (await s.journal.attemptsFor(s.hash, "patch_002")).length > 1
      ) {
        crashed = true;
        throw new Error("crash before dispatch");
      }
      return transition(id, from, to, patch);
    };
    expect((await s.run()).error).toBe("compensation: crash before dispatch");
    expect(s.world.tickets.get("5532")?.priority).toBe("high");

    const second = await s.run();
    expect(second.receipts.at(-1)).toMatchObject({ actionId: "patch_002", outcome: "compensated" });
    expect((await s.journal.attemptsFor(s.hash, "patch_002")).map((a) => a.state)).toEqual([
      "confirmed",
      "prepared",
      "confirmed",
    ]);
    expect(s.world.tickets.get("5532")?.priority).toBe("normal");
  });

  it.each([
    ["an identical revision", () => {}],
    [
      "a revision that changes case 2's refund",
      (m: ReplayBundle["manifest"]) => {
        const refund = m.actions.find((a) => a.id === "refund_002");
        if (refund?.kind === "stripe.refund.create") refund.args.reason = "requested_by_customer";
      },
    ],
  ])("never reports an undone patch as confirmed under %s", async (_name, change) => {
    const bundle = noteFails();
    const s = setup(bundle);
    replay(s, bundle);
    await s.run();
    expect(s.world.tickets.get("5532")?.priority).toBe("normal");

    const rev2 = s.addRevision(change);
    const writes = s.ticketWrites();
    await rev2.run();
    await rev2.run();
    // One receipt for the revision, saying the patch was undone, however often it runs.
    const receipts = (await s.journal.receiptsFor(rev2.hash)).filter(
      (r) => r.actionId === "patch_002",
    );
    expect(receipts.map((r) => r.outcome)).toEqual(["compensated"]);
    expect(receipts[0]?.limitations[0]).toMatch(/^compensated under plan hash \w+; not re-sent$/);
    expect(s.ticketWrites()).toBe(writes);
    expect(s.world.tickets.get("5532")?.priority).toBe("normal");
  });

  it.each([
    ["an identical revision", () => {}],
    [
      "a revision that changes the note, so nothing compensates",
      (m: ReplayBundle["manifest"]) => {
        const note = m.actions.find((a) => a.id === "note_002");
        if (note?.kind === "zendesk.ticket.appendPrivateNote") note.args.template.version += 1;
      },
    ],
  ])("reads, never adopts, a patch whose undo response was lost, under %s", async (_n, change) => {
    const bundle = noteFails();
    const s = setup(bundle);
    replay(s, bundle, () => s.world.fault(TICKET, { kind: "drop_response_after_commit" }));
    await s.run();
    expect(s.world.tickets.get("5532")?.priority).toBe("normal");
    const writes = s.ticketWrites();

    const rev2 = s.addRevision(change);
    await rev2.run();
    await rev2.run();
    const receipts = await patchReceipts(s, rev2.hash);
    expect(receipts.map((r) => r.outcome)).toEqual(["compensated"]);
    expect(receipts[0]?.limitations.at(-1)).toMatch(/found by reading the provider/);
    expect(s.ticketWrites()).toBe(writes);
    expect(s.world.tickets.get("5532")?.priority).toBe("normal");
  });

  it.each([
    [
      "a partial undo (status has no before value)",
      () => twoFields(noteFails(), { priority: "normal" }),
      "held",
      { priority: "normal", status: "pending" },
      ["held"],
    ],
    [
      // Nothing was written, so revision 2 adopts the applied patch and compensates it itself.
      "a teammate's priority plus a status to undo by hand (the hold wins)",
      () => twoFields(teammateConflictBundle(), {}),
      "held",
      { priority: "urgent", status: "pending" },
      ["confirmed", "held"],
    ],
    [
      "a partial undo that kept a teammate's priority",
      () => twoFields(teammateConflictBundle(), { priority: "normal", status: "open" }),
      "compensation_conflict",
      { priority: "urgent", status: "open" },
      ["compensation_conflict"],
    ],
  ])(
    "keeps the outcome of %s on re-runs and revisions",
    async (_n, make, outcome, ticket, rev2Outcomes) => {
      const bundle = make();
      const s = setup(bundle);
      replay(s, bundle);
      await s.run();
      await s.run();
      expect((await patchReceipts(s, s.hash)).map((r) => r.outcome)).toEqual([
        "confirmed",
        outcome,
      ]);

      const rev2 = s.addRevision();
      await rev2.run();
      await rev2.run();
      expect((await patchReceipts(s, rev2.hash)).map((r) => r.outcome)).toEqual(rev2Outcomes);
      expect(s.world.tickets.get("5532")).toMatchObject(ticket);
    },
  );

  it("reports a patch this hash confirmed as compensated once another revision undid it", async () => {
    const bundle = noteFails();
    const s = setup(bundle);
    replay(s, bundle);
    const compensate = s.deps.compensate;
    s.deps.compensate = undefined;
    await s.run();
    s.deps.compensate = compensate;
    const rev2 = s.addRevision();
    await rev2.run();
    expect((await patchReceipts(s, rev2.hash)).map((r) => r.outcome)).toEqual([
      "confirmed",
      "compensated",
    ]);
    const writes = s.ticketWrites();

    await s.run();
    expect((await patchReceipts(s, s.hash)).map((r) => r.outcome)).toEqual([
      "confirmed",
      "compensated",
    ]);
    expect(s.ticketWrites()).toBe(writes);
  });

  it("does not compensate twice across runs", async () => {
    const bundle = noteFails();
    const s = setup(bundle);
    replay(s, bundle);
    await s.run();
    const writes = s.ticketWrites();
    const second = await s.run();
    expect(second.receipts.some((r) => r.outcome === "compensated")).toBe(false);
    expect(s.ticketWrites()).toBe(writes);
  });

  it("undoes a case's patch when its refund is refused, and leaves the other case alone", async () => {
    const s = setup(happyPathBundle());
    s.world.fault("/v1/refunds", { kind: "reject", status: 400, retryable: false });
    const result = await s.run();
    expect(outcomes(result.receipts)).toMatchObject({
      refund_001: "rejected",
      patch_001: "compensated",
      note_001: "skipped_dependency",
      refund_002: "confirmed",
      patch_002: "confirmed",
      note_002: "confirmed",
    });
    expect(s.world.tickets.get("5531")?.priority).toBe("normal");
    expect(s.world.tickets.get("5532")?.priority).toBe("high");
  });

  it.each([
    ["an unknown note outcome", { kind: "server_error" as const }],
    [
      "a throttle no later run is barred from retrying",
      { kind: "reject" as const, status: 429, retryable: true, retryAfterMs: 60_000 },
    ],
  ])("leaves the patch alone after %s", async (_name, fault) => {
    const s = setup(happyPathBundle());
    const zendesk = s.providers.zendesk;
    const dispatch = zendesk.dispatch;
    zendesk.dispatch = async (request, ctx) => {
      if (request.path === TICKET && request.body.includes('"comment"'))
        s.world.fault(TICKET, fault);
      return dispatch(request, ctx);
    };
    const result = await s.run();
    expect(result.receipts.some((r) => r.outcome === "compensated")).toBe(false);
    expect(outcomes(result.receipts).patch_002).toBe("confirmed");
    expect(s.world.tickets.get("5532")?.priority).toBe("high");
  });

  it("sends no undo once the grant is revoked, and says so", async () => {
    const bundle = noteFails();
    const s = setup(bundle);
    replay(s, bundle, () =>
      s.store.grants.set(APPROVAL, { ...s.grant, revokedAt: "2026-10-21T12:00:00.000Z" }),
    );
    const result = await s.run();
    expect(result.receipts.at(-1)).toMatchObject({
      actionId: "patch_002",
      outcome: "held",
      holdReason: { kind: "approval_invalid" },
    });
    expect(s.world.tickets.get("5532")?.priority).toBe("high");
    expect(s.ticketWrites()).toBe(1);
  });

  it.each([
    ["a re-run of the same hash", (s: Setup) => s.run()],
    ["another revision", (s: Setup) => s.addRevision().run()],
  ])(
    "does not resend a lost refund or its note while a lost undo is still open, under %s",
    async (_name, next) => {
      const { s, refunds } = lostRefundAfterUndo(false);
      const dispatch = s.providers.zendesk.dispatch;
      let lostUndo = true;
      s.providers.zendesk.dispatch = async (request, ctx) => {
        if (
          lostUndo &&
          request.body.includes("rehearsal-op") &&
          request.body.includes('"safe_update"')
        ) {
          lostUndo = false;
          return { kind: "unknown", error: "lost undo" };
        }
        return dispatch(request, ctx);
      };

      const first = await s.run();
      expect(outcomes(first.receipts)).toMatchObject({
        patch_002: "held",
        refund_002: "unknown_outcome",
        note_002: "skipped_dependency",
      });
      expect(refunds()).toBe(0);
      expect(s.world.tickets.get("5532")?.priority).toBe("high");

      await next(s);
      expect(refunds()).toBe(0);
      expect(noteComments(s)).toHaveLength(0);
      expect(s.world.tickets.get("5532")?.priority).toBe("normal");
    },
  );

  it("does not send a throttled dependent while its predecessor's undo is still open", async () => {
    const s = dependentNote();
    s.deps.reconcileAfterMs = 0;
    s.deps.retry = { maxAttempts: 1 };
    const dispatch = s.providers.zendesk.dispatch;
    let notes = 0;
    let lostUndo = true;
    s.providers.zendesk.dispatch = async (request, ctx) => {
      const userNote =
        request.path === TICKET &&
        request.body.includes('"comment"') &&
        !request.body.includes('"safe_update"');
      if (userNote && ++notes === 2) {
        return { kind: "rejected", status: 429, body: { error: "throttled" }, retryable: true };
      }
      if (
        lostUndo &&
        request.body.includes("rehearsal-op") &&
        request.body.includes('"safe_update"')
      ) {
        lostUndo = false;
        return { kind: "unknown", error: "lost undo" };
      }
      return dispatch(request, ctx);
    };

    const first = await s.run();
    expect(outcomes(first.receipts)).toMatchObject({ note_002b: "rejected", patch_002: "held" });
    expect(noteComments(s)).toHaveLength(0);

    await s.run();
    expect(noteComments(s)).toHaveLength(0);
    expect(s.world.tickets.get("5532")?.priority).toBe("normal");
  });

  it("does not close a lost undo or adopt the patch when the new revision no longer compensates", async () => {
    const bundle = noteFails();
    const s = setup(bundle);
    const dispatch = s.providers.zendesk.dispatch;
    let noteOnce = true;
    let undoLost = true;
    s.providers.zendesk.dispatch = async (request, ctx) => {
      const userNote =
        request.path === TICKET &&
        request.body.includes('"comment"') &&
        !request.body.includes('"safe_update"');
      if (userNote && noteOnce) {
        noteOnce = false;
        return { kind: "rejected", status: 422, body: { error: "injected" }, retryable: false };
      }
      if (
        undoLost &&
        request.body.includes("rehearsal-op") &&
        request.body.includes('"safe_update"')
      ) {
        undoLost = false;
        return { kind: "unknown", error: "lost undo" };
      }
      return dispatch(request, ctx);
    };
    await s.run();
    expect(s.world.tickets.get("5532")?.priority).toBe("high");
    (s.deps.clock as FakeClock).advance(60_000);

    const rev2 = s.addRevision((m) => {
      const note = m.actions.find((a) => a.id === "note_002");
      if (note?.kind === "zendesk.ticket.appendPrivateNote") note.args.template.version = 2;
    });
    const first = await rev2.run();
    const second = await rev2.run();
    expect(outcomes(first.receipts).patch_002).not.toBe("confirmed");
    expect(outcomes(second.receipts).patch_002).not.toBe("confirmed");
    const undo = (await s.journal.attemptsFor(s.hash, "patch_002")).find((a) =>
      a.request.body.includes("rehearsal-op"),
    );
    expect(undo?.state).toBe("unknown_outcome");
    expect(s.world.tickets.get("5532")?.priority).toBe("high");
  });

  it("does not close a lost undo when the run is cancelled", async () => {
    const bundle = noteFails();
    const s = setup(bundle);
    replay(s, bundle, () => s.world.fault(TICKET, { kind: "server_error" }));
    await s.run();
    (s.deps.clock as FakeClock).advance(60_000);
    s.store.cancelled.add(RUN);
    const writes = s.ticketWrites();

    const second = await s.run();
    expect(second.state).toBe("cancelled");
    const undo = (await s.journal.attemptsFor(s.hash, "patch_002")).find((a) =>
      a.request.body.includes("rehearsal-op"),
    );
    expect(undo?.state).toBe("unknown_outcome");
    expect(s.ticketWrites()).toBe(writes);
    expect(s.world.tickets.get("5532")?.priority).toBe("high");
  });

  it("records a lost undo once when the same revision is applied three times", async () => {
    const bundle = noteFails();
    const s = setup(bundle);
    replay(s, bundle, () => s.world.fault(TICKET, { kind: "server_error" }));
    await s.run();
    (s.deps.clock as FakeClock).advance(60_000);
    const rev2 = s.addRevision();
    await rev2.run();
    await rev2.run();
    await rev2.run();

    expect(
      (await patchReceipts(s, rev2.hash)).filter((r) => r.outcome === "compensated"),
    ).toHaveLength(1);
    expect(s.world.tickets.get("5532")?.priority).toBe("normal");
  });

  it("records a conflict when a landed undo left a field a teammate had changed", async () => {
    const bundle = twoFields(noteFails(), { priority: "normal", status: "open" });
    const s = setup(bundle);
    replay(s, bundle, () => {
      s.world.teammateEdit("5532", "status", "solved");
      s.world.fault(TICKET, { kind: "drop_response_after_commit" });
    });
    await s.run();
    expect(s.world.tickets.get("5532")).toMatchObject({ priority: "normal", status: "solved" });

    await s.run();
    const receipt = (await patchReceipts(s, s.hash)).at(-1);
    expect(receipt?.outcome).toBe("compensation_conflict");
    expect(receipt?.limitations.join(" ")).toMatch(/kept status/);
    expect(s.world.tickets.get("5532")).toMatchObject({ priority: "normal", status: "solved" });
  });

  it("reverts a field that was put back to our value after a partial undo", async () => {
    const bundle = twoFields(noteFails(), { priority: "normal", status: "open" });
    const s = setup(bundle);
    replay(s, bundle, () => {
      s.world.teammateEdit("5532", "status", "solved");
      s.world.fault(TICKET, { kind: "drop_response_after_commit" });
    });
    await s.run();
    s.world.teammateEdit("5532", "status", "pending");

    await s.run();
    expect(s.world.tickets.get("5532")).toMatchObject({ priority: "normal", status: "open" });
    expect((await patchReceipts(s, s.hash)).at(-1)?.outcome).toBe("compensated");
  });

  it("calls a late landing of our own undo compensated, not a conflict", async () => {
    const bundle = noteFails();
    const s = setup(bundle);
    replay(s, bundle, () => s.world.fault(TICKET, { kind: "server_error" }));
    await s.run();
    (s.deps.clock as FakeClock).advance(60_000);
    const undo = (await s.journal.attemptsFor(s.hash, "patch_002")).find((a) =>
      a.request.body.includes("rehearsal-op"),
    );
    if (!undo) throw new Error("no undo");
    const marker = operationMarker(undo.operationKey);
    const dispatch = s.providers.zendesk.dispatch;
    let once = true;
    s.providers.zendesk.dispatch = async (request, ctx) => {
      if (once && request.body.includes("rehearsal-op") && request.body.includes('"safe_update"')) {
        once = false;
        s.world.teammateEdit("5532", "priority", "normal");
        s.world.tickets.get("5532")?.comments.push({ id: 99, body: marker, public: false });
      }
      return dispatch(request, ctx);
    };

    await s.run();
    const receipts = await patchReceipts(s, s.hash);
    expect(receipts.some((r) => r.outcome === "compensation_conflict")).toBe(false);
    expect(receipts.at(-1)?.outcome).toBe("compensated");
    expect(s.world.tickets.get("5532")?.priority).toBe("normal");
  });

  it("keeps a teammate's field when a follow-up undo lands late (#103)", async () => {
    const bundle = twoFields(noteFails(), { priority: "normal", status: "open" });
    const s = setup(bundle);
    replay(s, bundle, () => {
      s.world.teammateEdit("5532", "status", "solved");
      s.world.fault(TICKET, { kind: "drop_response_after_commit" });
    });
    await s.run();
    expect(s.world.tickets.get("5532")).toMatchObject({ priority: "normal", status: "solved" });
    // The follow-up only exists because status is back to the value we wrote.
    s.world.teammateEdit("5532", "status", "pending");
    const dispatch = s.providers.zendesk.dispatch;
    s.providers.zendesk.dispatch = async (request, ctx) => {
      if (request.body.includes('"status":"open"') && request.body.includes('"safe_update"')) {
        s.world.teammateEdit("5532", "status", "solved");
      }
      return dispatch(request, ctx);
    };
    const writes = s.ticketWrites();

    await s.run();
    const receipt = (await patchReceipts(s, s.hash)).at(-1);
    expect(receipt?.outcome).toBe("compensation_conflict");
    expect(receipt?.limitations.join(" ")).toMatch(/kept status = solved/);
    expect(s.world.tickets.get("5532")).toMatchObject({ priority: "normal", status: "solved" });
    expect(s.ticketWrites()).toBe(writes);
  });

  it("unwinds two patches of one field back to the original value (#109)", async () => {
    const bundle = stackedPriority(noteFails());
    const s = setup(bundle);
    replay(s, bundle);
    const result = await s.run();

    expect(result.error).toBeNull();
    expect(outcomes(result.receipts)).toMatchObject({
      patch_002: "compensated",
      patch_002b: "compensated",
      note_002: "rejected",
    });
    expect(result.receipts.some((r) => r.outcome === "compensation_conflict")).toBe(false);
    expect(s.world.tickets.get("5532")?.priority).toBe("normal");
    expect(s.ticketWrites()).toBe(4);
  });

  it("keeps a teammate's edit on a two-patch chain (#109)", async () => {
    const bundle = stackedPriority(noteFails());
    const s = setup(bundle);
    replay(s, bundle, () => s.world.teammateEdit("5532", "priority", "low"));
    const result = await s.run();

    expect(outcomes(result.receipts)).toMatchObject({
      patch_002: "compensation_conflict",
      patch_002b: "compensation_conflict",
    });
    expect(s.world.tickets.get("5532")?.priority).toBe("low");
    expect(s.ticketWrites()).toBe(2);
  });

  it("keeps a teammate value that equals an earlier patch's write (#109)", async () => {
    const bundle = stackedPriority(noteFails());
    const s = setup(bundle);
    replay(s, bundle, () => s.world.teammateEdit("5532", "priority", "high"));
    const result = await s.run();

    expect(outcomes(result.receipts)).toMatchObject({
      patch_002: "compensation_conflict",
      patch_002b: "compensation_conflict",
    });
    expect(s.world.tickets.get("5532")?.priority).toBe("high");
    expect(s.ticketWrites()).toBe(2);
  });

  it("waits to unwind an older patch when the latest undo never landed (#109)", async () => {
    const bundle = stackedPriority(noteFails());
    const s = setup(bundle);
    replay(s, bundle, () => s.world.fault(TICKET, { kind: "server_error" }));
    const first = await s.run();

    expect(s.world.tickets.get("5532")?.priority).toBe("urgent");
    expect(outcomes(first.receipts).patch_002b).toBe("held");
    expect(outcomes(first.receipts).patch_002).toBe("confirmed");
    expect(first.receipts.some((r) => r.outcome === "compensation_conflict")).toBe(false);

    (s.deps.clock as FakeClock).advance(60_000);
    const second = await s.run();
    expect(second.error).toBeNull();
    expect(outcomes(second.receipts)).toMatchObject({
      patch_002: "compensated",
      patch_002b: "compensated",
    });
    expect(s.world.tickets.get("5532")?.priority).toBe("normal");
  });

  it("settles a lost latest undo before undoing the older patch (#109)", async () => {
    const bundle = stackedPriority(noteFails());
    const s = setup(bundle);
    replay(s, bundle, () => s.world.fault(TICKET, { kind: "drop_response_after_commit" }));
    const first = await s.run();

    expect(s.world.tickets.get("5532")?.priority).toBe("high");
    expect(outcomes(first.receipts).patch_002b).toBe("held");
    expect(outcomes(first.receipts).patch_002).toBe("confirmed");
    const writes = s.ticketWrites();

    const second = await s.run();
    expect(outcomes(second.receipts)).toMatchObject({
      patch_002: "compensated",
      patch_002b: "compensated",
    });
    expect(s.world.tickets.get("5532")?.priority).toBe("normal");
    expect(s.ticketWrites()).toBe(writes + 1);
    expect(
      (await s.journal.attemptsFor(s.hash, "patch_002b")).some(
        (a) => a.state === "unknown_outcome",
      ),
    ).toBe(false);
  });

  it("does not blame a teammate when the latest undo stops after repeated 409s (#109)", async () => {
    const bundle = stackedPriority(noteFails());
    const s = setup(bundle);
    replay(s, bundle, () =>
      editAfterReread(s, () => s.world.teammateEdit("5532", "status", "pending")),
    );
    const first = await s.run();

    expect(s.world.tickets.get("5532")?.priority).toBe("urgent");
    expect(outcomes(first.receipts).patch_002b).toBe("held");
    expect(outcomes(first.receipts).patch_002).toBe("confirmed");
    expect(first.receipts.some((r) => r.outcome === "compensation_conflict")).toBe(false);

    const second = await s.run();
    expect(second.receipts.some((r) => r.outcome === "compensation_conflict")).toBe(false);
    expect((await patchReceipts(s, s.hash)).at(-1)?.outcome).toBe("confirmed");
    expect(s.world.tickets.get("5532")?.priority).toBe("urgent");
  });

  it("unwinds a restored field when a later patch conflicts on another (#109)", async () => {
    const bundle = stackedPriority(noteFails());
    const later = bundle.manifest.actions.find((a) => a.id === "patch_002b");
    if (later?.kind !== "zendesk.ticket.patchFields") throw new Error("no patch_002b");
    later.args = {
      ticketId: later.args.ticketId,
      set: { priority: "urgent", status: "pending" },
      before: { priority: "high", status: "open" },
    };
    const s = setup(bundle);
    replay(s, bundle, () => s.world.teammateEdit("5532", "status", "solved"));
    const first = await s.run();

    expect(outcomes(first.receipts)).toMatchObject({
      patch_002: "compensated",
      patch_002b: "compensation_conflict",
    });
    expect(
      first.receipts
        .filter((r) => r.actionId === "patch_002b")
        .at(-1)
        ?.limitations.join(" "),
    ).toMatch(/restored priority/);
    expect(s.world.tickets.get("5532")).toMatchObject({ priority: "normal", status: "solved" });
    const writes = s.ticketWrites();

    const second = await s.run();
    expect(second.receipts.some((r) => r.actionId === "patch_002")).toBe(false);
    expect(s.ticketWrites()).toBe(writes);
    expect(s.world.tickets.get("5532")).toMatchObject({ priority: "normal", status: "solved" });
  });
});
