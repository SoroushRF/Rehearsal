import { readFileSync } from "node:fs";
import type { PlanManifest } from "@rehearsal/contracts";
import {
  type BillingPolicyV1,
  type ExecutorDeps,
  executeRun,
  type ProviderPort,
  planHash,
} from "@rehearsal/core";
import {
  eraAdmin,
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
  ENABLED,
  getComments,
  getJson,
  getTicket,
  resetScratchTenants,
  scratchWorld,
  uniqueTenant,
} from "../src/harness";

const FIXTURES = new URL("../../../scenarios/billing/fixtures/", import.meta.url);
const CHARGE_ID = "ch_rehearsalT35lost1";
const TICKET = 4000001;

/** Forward every write to Era, but lose the response of the first send of each step. */
function losingResponses(port: ProviderPort): ProviderPort {
  const lost = new Set<string>();
  return {
    ...port,
    dispatch: async (req, ctx) => {
      const result = await port.dispatch(req, ctx);
      const step = `${req.path} ${req.body.includes('"comment"') ? "note" : "write"}`;
      if (lost.has(step)) return result;
      lost.add(step);
      return { kind: "unknown", error: "response lost after Era applied it (test transport)" };
    },
  };
}

/**
 * T3.5 gate on Era: every write lands but its response is lost, and the executor "restarts"
 * (maxAttempts 1: no in-run re-send). Each restart reconciles through real reads (refund by
 * metadata key, patch by fields, note by marker) and nothing is applied twice.
 */
describe.skipIf(!ENABLED)("reconcile lost responses through Era reads", () => {
  let stripe: WorldConfig;
  let zendesk: WorldConfig;
  let manifest: PlanManifest;
  let commentsBefore: number;

  beforeAll(async () => {
    const tenant = uniqueTenant("t35");
    stripe = await scratchWorld("stripe", "operational", tenant);
    zendesk = await scratchWorld("zendesk", "operational", tenant);
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

    const ticket = await getTicket(zendesk, TICKET);
    commentsBefore = (await getComments(zendesk, TICKET)).length;
    const base = billingManifest(`plan_t35_${tenant}`);
    manifest = {
      ...base,
      actions: base.actions
        .filter((a) => a.caseId === "case_001")
        .map((a) => {
          const copy = structuredClone(a);
          if (copy.kind === "stripe.refund.create") copy.args.chargeId = CHARGE_ID;
          else if (copy.kind !== "slack.message.postSummary") copy.args.ticketId = String(TICKET);
          if (copy.kind === "zendesk.ticket.patchFields") {
            copy.args.before = { priority: ticket.priority as "low" };
            copy.args.set = { priority: ticket.priority === "high" ? "urgent" : "high" };
          }
          return copy;
        }),
    };
  });

  afterAll(resetScratchTenants);

  it("restarts until every lost write is found by reading, each applied exactly once", async () => {
    const hash = planHash(manifest);
    const store = new MemoryApplyStore();
    store.runs.set("run", {
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
    let n = 0;
    const deps: ExecutorDeps = {
      store,
      journal: new MemoryJournal(),
      clock: new FakeClock("2026-10-22T12:00:00.000Z"),
      providers: {
        stripe: losingResponses(
          writeOnly(
            stripeWriter({
              world: "operational",
              config: stripe,
              authorization: "Bearer sk_test_t35",
            }),
          ),
        ),
        zendesk: losingResponses(
          writeOnly(
            zendeskWriter({ world: "operational", config: zendesk, authorization: "Bearer t35" }),
          ),
        ),
      },
      worlds: {
        stripe: { world: "operational", tenant: stripe.tenant },
        zendesk: { world: "operational", tenant: zendesk.tenant },
      },
      policies: [policy as BillingPolicyV1],
      newId: (p) => `${p}_${++n}`,
      retry: { maxAttempts: 1 },
    };
    const job = {
      orgId: manifest.orgId,
      runId: "run",
      planId: manifest.planId,
      revision: 1,
      planHash: hash,
    };
    const byStep = (r: Awaited<ReturnType<typeof executeRun>>) =>
      Object.fromEntries(r.receipts.map((x) => [x.actionId, x.outcome]));

    // Run 1: refund and patch land, both responses lost; the note waits on the refund.
    const run1 = await executeRun(job, deps);
    expect(byStep(run1)).toEqual({
      refund_001: "unknown_outcome",
      patch_001: "unknown_outcome",
      note_001: "skipped_dependency",
    });
    // Run 2: refund found by its metadata key, patch by its fields; the note lands, response lost.
    const run2 = await executeRun(job, deps);
    expect(byStep(run2)).toEqual({
      refund_001: "confirmed",
      patch_001: "confirmed",
      note_001: "unknown_outcome",
    });
    // Run 3: the note is found by its operation marker.
    const run3 = await executeRun(job, deps);
    expect(byStep(run3)).toEqual({ note_001: "confirmed" });
    expect(run3.state).toBe("completed");

    const refunds = await getJson<{ data: Array<{ id: string }> }>(
      "stripe",
      stripe,
      `/v1/refunds?charge=${CHARGE_ID}&limit=100`,
    );
    expect(refunds.data).toHaveLength(1);
    const comments = await getComments(zendesk, TICKET);
    expect(comments).toHaveLength(commentsBefore + 1);
    expect(comments.at(-1)?.public).toBe(false);
    expect(comments.at(-1)?.body).toContain(refunds.data[0]?.id);
    const refundReceipt = run2.receipts.find((r) => r.actionId === "refund_001");
    expect(refundReceipt?.providerRef).toEqual({
      vendor: "stripe",
      kind: "refund",
      id: refunds.data[0]?.id,
    });
  });
});
