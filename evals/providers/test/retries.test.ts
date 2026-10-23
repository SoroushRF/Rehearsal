import { readFileSync } from "node:fs";
import type { PlanManifest } from "@rehearsal/contracts";
import { type BillingPolicyV1, executeRun, planHash } from "@rehearsal/core";
import { eraAdmin, stripeWriter, type WorldConfig, writeOnly } from "@rehearsal/providers";
import { billingManifest, FakeClock, MemoryApplyStore, MemoryJournal } from "@rehearsal/testkit";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import policy from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import {
  adminToken,
  ENABLED,
  getJson,
  resetScratchTenants,
  scratchWorld,
  uniqueTenant,
} from "../src/harness";

const FIXTURES = new URL("../../../scenarios/billing/fixtures/", import.meta.url);

/** Era's container-wide fault controls (they fire before the handler, so they have no effect). */
async function setFaults(world: WorldConfig, config: Record<string, unknown> | null) {
  const path = config === null ? "/_admin/faults/reset" : "/_admin/faults";
  const res = await fetch(`${world.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken()}` },
    body: config === null ? undefined : JSON.stringify(config),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
}

/**
 * T3.4 gate: Era fault injection → retried, one effect. Faults are container-wide; this project
 * runs its files serially (vitest.config.ts) and every test clears them afterwards.
 */
describe.skipIf(!ENABLED)("executor retries under Era fault injection", () => {
  let stripe: WorldConfig;

  beforeAll(async () => {
    stripe = await scratchWorld("stripe", "operational", uniqueTenant("t34"));
  });
  afterEach(() => setFaults(stripe, null));
  afterAll(resetScratchTenants);

  /** A one-refund plan on a freshly injected CAD charge, approved and ready to run. */
  async function refundRun(
    chargeId: string,
    sleep?: (ms: number) => Promise<void>,
    beforeRun?: () => Promise<void>,
  ) {
    const template = JSON.parse(readFileSync(new URL("stripe.charge.json", FIXTURES), "utf8"));
    const charge = {
      ...template,
      id: chargeId,
      amount: 4210,
      amount_captured: 4210,
      currency: "cad",
    };
    const injected = await eraAdmin(stripe, adminToken(), "/inject", { charges: [charge] });
    if (!injected.ok) throw new Error(`inject → ${injected.status}`);

    const base = billingManifest(`plan_${chargeId}`);
    const manifest: PlanManifest = {
      ...base,
      actions: base.actions
        .filter((a) => a.id === "refund_001")
        .map((a) => {
          const copy = structuredClone(a);
          if (copy.kind === "stripe.refund.create") copy.args.chargeId = chargeId;
          return copy;
        }),
    };
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
    const journal = new MemoryJournal();
    let n = 0;
    await beforeRun?.();
    const result = await executeRun(
      { orgId: manifest.orgId, runId: "run", planId: manifest.planId, revision: 1, planHash: hash },
      {
        store,
        journal,
        clock: new FakeClock("2026-10-22T12:00:00.000Z"),
        providers: {
          stripe: writeOnly(
            stripeWriter({
              world: "operational",
              config: stripe,
              authorization: "Bearer sk_test_t34",
            }),
          ),
        },
        worlds: { stripe: { world: "operational", tenant: stripe.tenant } },
        policies: [policy as BillingPolicyV1],
        newId: (p) => `${p}_${++n}`,
        ...(sleep && { sleep }),
      },
    );
    const refunds = await getJson<{ data: unknown[] }>(
      "stripe",
      stripe,
      `/v1/refunds?charge=${chargeId}&limit=100`,
    );
    const attempts = (await journal.attemptsFor(hash, "refund_001")).map((a) => [
      a.state,
      a.providerStatus,
    ]);
    return { result, refunds: refunds.data.length, attempts };
  }

  it("retries a throttled refund after Era's Retry-After and applies it once", async () => {
    // Throttle every request from just before the run; the backoff waits out Era's Retry-After
    // and lifts the throttle, so exactly the first send is refused. (A one-shot `fail_next` can be
    // consumed by any request that reaches the container first, which made this flaky.)
    const waits: number[] = [];
    const { result, refunds, attempts } = await refundRun(
      "ch_rehearsalT34throt",
      async (ms) => {
        waits.push(ms);
        await new Promise((r) => setTimeout(r, ms));
        await setFaults(stripe, null);
      },
      () => setFaults(stripe, { throttle: true, retry_after_seconds: 1 }),
    );
    expect(result.state).toBe("completed");
    expect(attempts).toEqual([
      ["rejected", 429],
      ["confirmed", 200],
    ]);
    expect(refunds).toBe(1);
    expect(waits).toEqual([1000]); // Era's Retry-After, honoured
  });

  it("re-sends a refund after an Era 500 under the same key and applies it once", async () => {
    await setFaults(stripe, { error_rate: 1.0 });
    // The fault clears during the backoff, so the re-send reaches the handler.
    const { result, refunds, attempts } = await refundRun("ch_rehearsalT34err5", () =>
      setFaults(stripe, null),
    );
    expect(result.state).toBe("completed");
    expect(attempts).toEqual([
      ["reconciled", null],
      ["confirmed", 200],
    ]);
    expect(refunds).toBe(1);
  });
});
