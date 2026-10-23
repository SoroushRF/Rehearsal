import type { ReplayBundle } from "@rehearsal/contracts";
import {
  type BillingPolicyV1,
  createCompensator,
  createReadGuard,
  type DispatchResult,
  type ExecutorDeps,
  executeRun,
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
        (a.kind === "zendesk.ticket.appendPrivateNote") === body.includes('"comment"'),
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

  it("keeps an edit made between the compensation re-read and the undo (409)", async () => {
    const bundle = noteFails();
    const s = setup(bundle);
    replay(s, bundle, () => {
      const observe = s.providers.zendesk.observe;
      s.providers.zendesk.observe = async (entity, ctx) => {
        const read = await observe(entity, ctx);
        if (entity.id === "5532") s.world.teammateEdit("5532", "priority", "low");
        return read;
      };
    });
    const result = await s.run();

    expect(result.receipts.at(-1)).toMatchObject({
      actionId: "patch_002",
      outcome: "compensation_conflict",
      observedEffect: { status: 409 },
    });
    expect(s.world.tickets.get("5532")?.priority).toBe("low");
  });

  it("holds a lost undo response and never re-sends it on a later run", async () => {
    const bundle = noteFails();
    const s = setup(bundle);
    replay(s, bundle, () => s.world.fault(TICKET, { kind: "drop_response_after_commit" }));
    const first = await s.run();
    expect(first.receipts.at(-1)).toMatchObject({
      actionId: "patch_002",
      outcome: "held",
      holdReason: { kind: "unresolved_outcome" },
    });
    const writes = s.ticketWrites();

    // Not re-sent, and not held again for the same attempt.
    const second = await s.run();
    expect(second.receipts.some((r) => r.actionId === "patch_002")).toBe(false);
    expect(s.ticketWrites()).toBe(writes);
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
    expect(receipts[0]?.limitations[0]).toMatch(/^undone by attempt att_\d+ under plan hash /);
    expect(s.ticketWrites()).toBe(writes);
    expect(s.world.tickets.get("5532")?.priority).toBe("normal");
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
});
