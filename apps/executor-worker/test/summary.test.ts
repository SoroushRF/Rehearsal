import type { Action, ApprovalGrant, PlanManifest } from "@rehearsal/contracts";
import {
  type BillingPolicyV1,
  createReadGuard,
  type ExecutorDeps,
  executeRun,
  planHash,
} from "@rehearsal/core";
import {
  approvedGrant,
  FakeClock,
  fakeRunAdmit,
  happyPathBundle,
  MemoryApplyStore,
  MemoryJournal,
  worldFromManifest,
} from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import policy from "../../../scenarios/billing/policy.v1.json" with { type: "json" };

const RUN = "run_1";
const APPROVAL = "grant_1";
const REFUNDS = ["refund_001", "refund_002"];
const NOTES = ["note_001", "note_002"];

/** The happy-path plan with a run summary (T1.7) that counts its refunds. */
function withSummary(manifest: PlanManifest): PlanManifest {
  const summary: Action = {
    id: "summary",
    caseId: "run",
    obligationId: "run_summary",
    dependsOn: [...REFUNDS, ...NOTES],
    requiredRole: "support_lead",
    evidence: [],
    queryEvidence: [],
    compensation: "irreversible",
    protection: "no_atomic_guard",
    rationale: "Tell the channel what the run did.",
    kind: "slack.message.postSummary",
    args: {
      channelId: "chan-general",
      template: { id: "run-summary", version: 1 },
      bindings: {
        incidentId: "inc_dup_2026_10",
        refunded: { $count: "outcomes", stepIds: REFUNDS, outcomes: ["confirmed"] },
        held: {
          $count: "outcomes",
          stepIds: [...REFUNDS, ...NOTES],
          outcomes: ["held", "unknown_outcome", "rejected", "skipped_dependency"],
        },
      },
    },
  };
  // Listed first on purpose: the executor still runs it last.
  return { ...manifest, actions: [summary, ...manifest.actions] };
}

function setup(opts: { slack?: boolean; caseConcurrency?: number } = {}) {
  const manifest = withSummary(happyPathBundle().manifest);
  const hash = planHash(manifest);
  const store = new MemoryApplyStore();
  store.runs.set(RUN, {
    planId: manifest.planId,
    revision: 1,
    planHash: hash,
    approvalId: APPROVAL,
  });
  store.plans.set(`${manifest.planId}@1`, { planHash: hash, manifest });
  const grant: ApprovalGrant = approvedGrant({
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
  store.grants.set(APPROVAL, grant);
  const world = worldFromManifest(manifest.observations);
  const journal = new MemoryJournal();
  const clock = new FakeClock("2026-10-21T12:00:00.000Z");
  let n = 0;
  const slack = opts.slack ?? true;
  const deps: ExecutorDeps = {
    store,
    journal,
    clock,
    providers: {
      stripe: world.provider("stripe"),
      zendesk: world.provider("zendesk"),
      ...(slack && { slack: world.provider("slack") }),
    },
    worlds: {
      stripe: { world: "operational", tenant: "test" },
      zendesk: { world: "operational", tenant: "test" },
      ...(slack && { slack: { world: "operational", tenant: "test" } as const }),
    },
    policies: [policy as BillingPolicyV1],
    admit: fakeRunAdmit({ now: () => clock.now() }),
    newId: (prefix: string) => `${prefix}_${++n}`,
    sleep: async () => {},
    caseConcurrency: opts.caseConcurrency,
  };
  // The worker's own guard: a summary cites no evidence, so it has nothing to re-read.
  deps.guard = createReadGuard({
    providers: deps.providers,
    worlds: deps.worlds,
    clock: deps.clock,
  });
  const job = {
    orgId: manifest.orgId,
    runId: RUN,
    planId: manifest.planId,
    revision: 1,
    planHash: hash,
  };
  return { manifest, world, journal, deps, run: () => executeRun(job, deps) };
}

const outcomes = (receipts: { actionId: string; outcome: string }[]) =>
  Object.fromEntries(receipts.map((r) => [r.actionId, r.outcome]));

describe("run summary (T1.7)", () => {
  it.each([1, 4])(
    "posts once, after every other step, with counts of what happened (concurrency %i)",
    async (caseConcurrency) => {
      const s = setup({ caseConcurrency });
      const out = await s.run();
      expect(out.state).toBe("completed");
      expect(out.receipts.at(-1)?.actionId).toBe("summary");
      expect(s.world.messages).toHaveLength(1);
      expect(s.world.messages[0]?.text).toMatch(
        /^Billing remediation inc_dup_2026_10: 2 refund\(s\) issued, 0 step\(s\) held for review\.\n\n\[rehearsal-op:op_/,
      );
      const receipt = out.receipts.at(-1);
      expect(receipt?.providerRef).toEqual({
        vendor: "slack",
        kind: "message",
        id: s.world.messages[0]?.ts,
      });
      // The receipt UI calls this "Applied and read back" only on this phrase (#133).
      expect(receipt?.limitations).toContain("read back from the provider after the write");
    },
  );

  it("still posts when a step it counts was refused, and counts that step and its dependent", async () => {
    const s = setup();
    s.world.fault("/v1/refunds", { kind: "reject", status: 400, retryable: false });
    const out = await s.run();
    expect(outcomes(out.receipts)).toMatchObject({
      refund_001: "rejected",
      note_001: "skipped_dependency",
      refund_002: "confirmed",
      summary: "confirmed",
    });
    expect(s.world.messages[0]?.text).toContain("1 refund(s) issued, 2 step(s) held for review.");
  });

  it("reads a lost post back on the next delivery instead of posting it twice", async () => {
    const s = setup();
    s.world.fault("/api/chat.postMessage", { kind: "drop_response_after_commit" });
    const first = await s.run();
    expect(outcomes(first.receipts).summary).toBe("unknown_outcome");
    expect(s.world.messages).toHaveLength(1);

    const second = await s.run();
    const summary = second.receipts.find((r) => r.actionId === "summary");
    expect(summary?.outcome).toBe("confirmed");
    expect(summary?.limitations.join(" ")).toContain("found by reading the provider; not re-sent");
    expect(s.world.messages).toHaveLength(1);
    expect(summary?.providerRef?.id).toBe(s.world.messages[0]?.ts);
  });

  it("is refused at admission, before any refund, when no Slack provider is wired", async () => {
    const s = setup({ slack: false });
    const out = await s.run();
    expect(out.refusal).toBe("no operational provider for slack");
    expect(s.world.refunds).toHaveLength(0);
    expect(s.world.messages).toHaveLength(0);
  });

  it("still reads back a lost refund when Slack is unwired later", async () => {
    const s = setup();
    s.deps.retry = { maxAttempts: 1 };
    s.world.fault("/v1/refunds", { kind: "drop_response_after_commit" });
    expect(outcomes((await s.run()).receipts).refund_001).toBe("unknown_outcome");

    delete s.deps.providers.slack;
    delete s.deps.worlds.slack;
    const out = await s.run();
    expect(out.refusal).toBe("no operational provider for slack");
    expect(outcomes(out.receipts).refund_001).toBe("confirmed");
    expect(s.world.refunds.filter((r) => r.charge === "ch_fixture_001")).toHaveLength(1);
  });

  it("posts nothing when the run is cancelled", async () => {
    const s = setup();
    let cancelled = false;
    s.deps.store.runCancelled = async () => cancelled;
    const dispatch = s.deps.providers.stripe?.dispatch;
    if (!dispatch || !s.deps.providers.stripe) throw new Error("no stripe provider");
    s.deps.providers.stripe.dispatch = async (req, ctx) => {
      cancelled = true;
      return dispatch(req, ctx);
    };
    const out = await s.run();
    expect(out.state).toBe("cancelled");
    expect(s.world.messages).toHaveLength(0);
    expect(out.receipts.some((r) => r.actionId === "summary")).toBe(false);
  });
});
