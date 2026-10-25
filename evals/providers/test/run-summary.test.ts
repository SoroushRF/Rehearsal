import { readFileSync } from "node:fs";
import type { Action, PlanManifest } from "@rehearsal/contracts";
import { type BillingPolicyV1, type ExecutorDeps, executeRun, planHash } from "@rehearsal/core";
import {
  eraAdmin,
  slackProviderWriter,
  stripeWriter,
  type WorldConfig,
  writeOnly,
  zendeskWriter,
} from "@rehearsal/providers";
import { billingManifest, FakeClock, MemoryApplyStore, MemoryJournal } from "@rehearsal/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import policy from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import {
  adminToken,
  getJson,
  getTicket,
  resetScratchTenants,
  SEED,
  SLACK_ENABLED,
  scratchWorld,
  uniqueTenant,
} from "../src/harness";

const FIXTURES = new URL("../../../scenarios/billing/fixtures/", import.meta.url);
const CHARGE_ID = "ch_rehearsalT17cad1";
const CHANNEL = "chan-general";

interface History {
  ok: boolean;
  messages: { ts: string; text?: string }[];
}

/**
 * T1.7 on Era: a plan's run summary goes out last through the executor, counting what the case's
 * steps did, and the channel then holds exactly one post carrying its operation marker. Needs
 * `pnpm infra:up:full`, ERA_CONFORMANCE=1 and ERA_SLACK=1.
 */
describe.skipIf(!SLACK_ENABLED)("run summary through the executor on Era", () => {
  let stripe: WorldConfig;
  let zendesk: WorldConfig;
  let slack: WorldConfig;
  let manifest: PlanManifest;

  beforeAll(async () => {
    const tenant = uniqueTenant("t17");
    stripe = await scratchWorld("stripe", "operational", tenant);
    zendesk = await scratchWorld("zendesk", "operational", tenant);
    slack = await scratchWorld("slack", "operational", tenant);

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

    const ticket = await getTicket(zendesk, SEED.ticketId);
    const base = billingManifest(`plan_t17_${tenant}`);
    const steps = base.actions
      .filter((a) => a.caseId === "case_001")
      .map((a) => {
        const copy = structuredClone(a);
        if (copy.kind === "stripe.refund.create") copy.args.chargeId = CHARGE_ID;
        else if (copy.kind !== "slack.message.postSummary")
          copy.args.ticketId = String(SEED.ticketId);
        if (copy.kind === "zendesk.ticket.patchFields") {
          copy.args.before = { priority: ticket.priority as "low" };
        }
        return copy;
      });
    const ids = steps.map((a) => a.id);
    const summary: Action = {
      id: "run_summary",
      kind: "slack.message.postSummary",
      caseId: "run",
      obligationId: "run_summary",
      dependsOn: ids,
      requiredRole: "support_lead",
      evidence: [],
      queryEvidence: [],
      compensation: "irreversible",
      protection: "no_atomic_guard",
      rationale: "Tell the channel what the run did.",
      args: {
        channelId: CHANNEL,
        template: { id: "run-summary", version: 1 },
        bindings: {
          incidentId: tenant,
          refunded: { $count: "outcomes", stepIds: ["refund_001"], outcomes: ["confirmed"] },
          held: { $count: "outcomes", stepIds: ids, outcomes: ["held", "unknown_outcome"] },
        },
      },
    };
    manifest = { ...base, actions: [...steps, summary] };
  });

  afterAll(resetScratchTenants);

  it("posts one summary after the case, with its counts, and a re-delivery doesn't post again", async () => {
    const hash = planHash(manifest);
    const store = new MemoryApplyStore();
    store.runs.set("run_t17", {
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
            authorization: "Bearer sk_test_t17",
          }),
        ),
        zendesk: writeOnly(
          zendeskWriter({ world: "operational", config: zendesk, authorization: "Bearer t17" }),
        ),
        slack: writeOnly(
          slackProviderWriter({
            world: "operational",
            config: slack,
            authorization: "Bearer xoxb-t17",
          }),
        ),
      },
      worlds: {
        stripe: { world: "operational", tenant: stripe.tenant },
        zendesk: { world: "operational", tenant: zendesk.tenant },
        slack: { world: "operational", tenant: slack.tenant },
      },
      policies: [policy as BillingPolicyV1],
      newId: (p) => `${p}_${++n}`,
    };
    const job = {
      orgId: manifest.orgId,
      runId: "run_t17",
      planId: manifest.planId,
      revision: 1,
      planHash: hash,
    };
    const result = await executeRun(job, deps);

    expect(result.error).toBeNull();
    expect(result.state).toBe("completed");
    expect(result.receipts.map((r) => [r.actionId, r.outcome])).toEqual([
      ["refund_001", "confirmed"],
      ["patch_001", "confirmed"],
      ["note_001", "confirmed"],
      ["run_summary", "confirmed"],
    ]);
    const receipt = result.receipts.at(-1);
    expect(receipt?.limitations).toContain("read back from the provider after the write");

    const [attempt] = await journal.attemptsFor(hash, "run_summary");
    const marker = `[rehearsal-op:${attempt?.operationKey}]`;
    const posts = async () =>
      (
        await getJson<History>(
          "slack",
          slack,
          `/api/conversations.history?channel=${CHANNEL}&limit=200`,
        )
      ).messages.filter((m) => m.text?.includes(marker));
    const [post, ...others] = await posts();
    expect(others).toEqual([]);
    expect(post?.ts).toBe(receipt?.providerRef?.id);
    expect(post?.text).toMatch(
      /^Billing remediation \S+: 1 refund\(s\) issued, 0 step\(s\) held for review\./,
    );

    // A re-delivered job finds every receipt, the summary's included: nothing is posted twice.
    const again = await executeRun(job, deps);
    expect(again.state).toBe("completed");
    expect(await posts()).toHaveLength(1);
  });
});
