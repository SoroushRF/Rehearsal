import type { Action, ApprovalGrant, PlanManifest } from "@rehearsal/contracts";
import {
  type BillingPolicyV1,
  createReadGuard,
  type ExecutorDeps,
  executeRun,
  planHash,
  renderReply,
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
const TEMPLATE = { id: "refund-issued", version: 1 };

/** Case 001's refund plus a public reply (T1.13) announcing it. */
function withReply(
  manifest: PlanManifest,
  edit: (body: string) => string = (b) => b,
): PlanManifest {
  const refund = manifest.actions.find((a) => a.id === "refund_001");
  if (refund?.kind !== "stripe.refund.create") throw new Error("no refund_001");
  const ticketId = manifest.actions.find((a) => a.id === "note_001")?.args;
  if (!ticketId || !("ticketId" in ticketId)) throw new Error("no note_001");
  const values = { customerName: "Ana Ruiz", amountMinor: refund.args.amount.amountMinor };
  const reply: Action = {
    id: "reply_001",
    kind: "zendesk.ticket.appendPublicReply",
    caseId: refund.caseId,
    obligationId: refund.obligationId,
    dependsOn: [refund.id],
    requiredRole: "support_lead",
    evidence: ["obs_ticket_001"],
    queryEvidence: [],
    compensation: "irreversible",
    protection: "no_atomic_guard",
    rationale: "Tell the customer the refund went out.",
    args: {
      ticketId: ticketId.ticketId,
      public: true,
      template: TEMPLATE,
      values,
      body: edit(renderReply(TEMPLATE, values)),
    },
  };
  return { ...manifest, actions: [refund, reply] };
}

function setup(edit?: (body: string) => string) {
  const manifest = withReply(happyPathBundle().manifest, edit);
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
  const clock = new FakeClock("2026-10-21T12:00:00.000Z");
  let n = 0;
  const deps: ExecutorDeps = {
    store,
    journal: new MemoryJournal(),
    clock,
    providers: { stripe: world.provider("stripe"), zendesk: world.provider("zendesk") },
    worlds: {
      stripe: { world: "operational", tenant: "test" },
      zendesk: { world: "operational", tenant: "test" },
    },
    policies: [policy as BillingPolicyV1],
    admit: fakeRunAdmit({ now: () => clock.now() }),
    newId: (prefix: string) => `${prefix}_${++n}`,
    sleep: async () => {},
  };
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
  const reply = manifest.actions[1];
  if (reply?.kind !== "zendesk.ticket.appendPublicReply") throw new Error("no reply");
  const comments = () => world.tickets.get(reply.args.ticketId)?.comments ?? [];
  return { reply, world, comments, run: () => executeRun(job, deps) };
}

const outcomes = (receipts: { actionId: string; outcome: string }[]) =>
  Object.fromEntries(receipts.map((r) => [r.actionId, r.outcome]));

describe("public customer reply (T1.13)", () => {
  it("sends the approved text once, public, after its refund is confirmed", async () => {
    const s = setup();
    const out = await s.run();
    expect(out.state).toBe("completed");
    expect(outcomes(out.receipts)).toEqual({ refund_001: "confirmed", reply_001: "confirmed" });
    const [comment, ...others] = s.comments();
    expect(others).toEqual([]);
    expect(comment?.public).toBe(true);
    // Exactly the approved body, then the operation marker the executor adds.
    const [body, marker] = comment?.body.split("\n\n[rehearsal-op:") ?? [];
    expect(body).toBe(s.reply.args.body);
    expect(marker).toMatch(/^op_[0-9a-f]+\]$/);
    // The receipt UI calls this "Applied and read back" only on this phrase (#133).
    expect(out.receipts.at(-1)?.limitations).toContain(
      "read back from the provider after the write",
    );
  });

  it("isn't sent when its refund is refused", async () => {
    const s = setup();
    s.world.fault("/v1/refunds", { kind: "reject", status: 400, retryable: false });
    const out = await s.run();
    expect(outcomes(out.receipts)).toEqual({
      refund_001: "rejected",
      reply_001: "skipped_dependency",
    });
    expect(s.comments()).toEqual([]);
  });

  it("reads a lost send back on the next delivery instead of replying twice", async () => {
    const s = setup();
    s.world.fault(`/api/v2/tickets/${s.reply.args.ticketId}.json`, {
      kind: "drop_response_after_commit",
    });
    const first = await s.run();
    expect(outcomes(first.receipts).reply_001).toBe("unknown_outcome");
    expect(s.comments()).toHaveLength(1);

    const second = await s.run();
    const reply = second.receipts.find((r) => r.actionId === "reply_001");
    expect(reply?.outcome).toBe("confirmed");
    expect(reply?.limitations.join(" ")).toContain("found by reading the provider; not re-sent");
    expect(s.comments()).toHaveLength(1);
  });

  it("is refused at admission, before the refund, when the body isn't what its template renders", async () => {
    const s = setup((body) => `${body} Also, here's a coupon.`);
    const out = await s.run();
    expect(out.refusal).toBe(
      "reply_001: reply body doesn't match its approved template refund-issued@1",
    );
    expect(s.world.refunds).toHaveLength(0);
    expect(s.comments()).toEqual([]);
  });
});
