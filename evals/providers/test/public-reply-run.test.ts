import { readFileSync } from "node:fs";
import type { Action, PlanManifest } from "@rehearsal/contracts";
import {
  type BillingPolicyV1,
  type ExecutorDeps,
  executeRun,
  planHash,
  renderReply,
} from "@rehearsal/core";
import {
  eraAdmin,
  stripeWriter,
  type WorldConfig,
  writeOnly,
  zendeskWriter,
} from "@rehearsal/providers";
import {
  billingManifest,
  FakeClock,
  fakeRunAdmit,
  MemoryApplyStore,
  MemoryJournal,
} from "@rehearsal/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import policy from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import {
  adminToken,
  ENABLED,
  getComments,
  resetScratchTenants,
  SEED,
  scratchWorld,
  uniqueTenant,
} from "../src/harness";

const FIXTURES = new URL("../../../scenarios/billing/fixtures/", import.meta.url);
const CHARGE_ID = "ch_rehearsalT113cad1";
const TEMPLATE = { id: "refund-issued", version: 1 };

/**
 * T1.13 on Era: a plan's public reply goes out through the executor and `zendeskWriter` only after
 * its refund is confirmed, as exactly the approved text plus the operation marker, and a
 * re-delivered job doesn't reply twice. Needs `pnpm infra:up` and ERA_CONFORMANCE=1.
 */
describe.skipIf(!ENABLED)("public reply through the executor on Era", () => {
  let stripe: WorldConfig;
  let zendesk: WorldConfig;
  let manifest: PlanManifest;
  let body: string;

  beforeAll(async () => {
    const tenant = uniqueTenant("t113");
    stripe = await scratchWorld("stripe", "operational", tenant);
    zendesk = await scratchWorld("zendesk", "operational", tenant);

    // Policy v1 is CAD and the seeded charges are USD, so inject a CAD charge to refund.
    const template = JSON.parse(readFileSync(new URL("stripe.charge.json", FIXTURES), "utf8"));
    const charge = {
      ...template,
      id: CHARGE_ID,
      amount: 4210,
      amount_captured: 4210,
      currency: "cad",
    };
    const res = await eraAdmin(stripe, adminToken(), "/inject", { charges: [charge] });
    if (!res.ok) throw new Error(`inject → ${res.status} ${await res.text()}`);

    const base = billingManifest(`plan_t113_${tenant}`);
    const refund = structuredClone(base.actions.find((a) => a.id === "refund_001"));
    if (refund?.kind !== "stripe.refund.create") throw new Error("no refund_001");
    refund.args.chargeId = CHARGE_ID;
    const values = { customerName: "Ana Ruiz", amountMinor: refund.args.amount.amountMinor };
    body = renderReply(TEMPLATE, values);
    const reply: Action = {
      id: "reply_001",
      kind: "zendesk.ticket.appendPublicReply",
      caseId: refund.caseId,
      obligationId: refund.obligationId,
      dependsOn: [refund.id],
      requiredRole: "support_lead",
      evidence: [],
      queryEvidence: [],
      compensation: "irreversible",
      protection: "no_atomic_guard",
      rationale: "Tell the customer the refund went out.",
      args: {
        ticketId: String(SEED.ticketId),
        public: true,
        template: TEMPLATE,
        values,
        body,
      },
    };
    manifest = { ...base, actions: [refund, reply] };
  });

  afterAll(resetScratchTenants);

  it("replies once after the refund, with the approved text, and a re-delivery doesn't reply again", async () => {
    const hash = planHash(manifest);
    const store = new MemoryApplyStore();
    store.runs.set("run_t113", {
      planId: manifest.planId,
      revision: 1,
      planHash: hash,
      approvalId: "g",
    });
    store.plans.set(`${manifest.planId}@1`, { planHash: hash, manifest });
    store.grants.set("g", {
      id: "g",
      orgId: manifest.orgId,
      planId: manifest.planId,
      revision: 1,
      planHash: hash,
      actorUserId: "user_support",
      actorSessionId: "sess",
      roles: ["support_lead"],
      permissions: ["rehearsal:approve:support_step", "rehearsal:approve:finance_step"],
      authzRule: { id: "rehearsal-authz", version: 1 },
      grantedAt: "2026-10-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      revokedAt: null,
    });
    const journal = new MemoryJournal();
    let n = 0;
    const deps: ExecutorDeps = {
      store,
      journal,
      clock: new FakeClock("2026-10-21T12:00:00.000Z"),
      providers: {
        stripe: writeOnly(
          stripeWriter({
            world: "operational",
            config: stripe,
            authorization: "Bearer sk_test_t113",
          }),
        ),
        zendesk: writeOnly(
          zendeskWriter({ world: "operational", config: zendesk, authorization: "Bearer t113" }),
        ),
      },
      worlds: {
        stripe: { world: "operational", tenant: stripe.tenant },
        zendesk: { world: "operational", tenant: zendesk.tenant },
      },
      policies: [policy as BillingPolicyV1],
      admit: fakeRunAdmit({ now: () => new Date("2026-10-22T12:00:00.000Z") }),
      newId: (p) => `${p}_${++n}`,
    };
    const job = {
      orgId: manifest.orgId,
      runId: "run_t113",
      planId: manifest.planId,
      revision: 1,
      planHash: hash,
    };
    const result = await executeRun(job, deps);

    expect(result.error).toBeNull();
    expect(result.state).toBe("completed");
    expect(result.receipts.map((r) => [r.actionId, r.outcome])).toEqual([
      ["refund_001", "confirmed"],
      ["reply_001", "confirmed"],
    ]);
    expect(result.receipts.at(-1)?.limitations).toContain(
      "read back from the provider after the write",
    );

    const [attempt] = await journal.attemptsFor(hash, "reply_001");
    const marker = `[rehearsal-op:${attempt?.operationKey}]`;
    const ours = async () =>
      (await getComments(zendesk, SEED.ticketId)).filter((c) => c.body.includes(marker));
    const [comment, ...others] = await ours();
    expect(others).toEqual([]);
    expect(comment?.public).toBe(true);
    expect(comment?.body).toBe(`${body}\n\n${marker}`);

    // A re-delivered job finds both receipts: nothing is refunded or replied twice.
    const again = await executeRun(job, deps);
    expect(again.state).toBe("completed");
    expect(await ours()).toHaveLength(1);
  });
});
