import { existsSync } from "node:fs";
import type { Attempt } from "@rehearsal/contracts";
import { stripeWriter, type WriteTarget } from "@rehearsal/providers";
import { happyPathBundle } from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import {
  STRIPE_API,
  sandboxClient,
  sandboxKey,
  seedSandbox,
} from "../../../scripts/stripe-sandbox/sandbox";

// T3.17 against a real Stripe **test-mode** account: opt-in only (STRIPE_SANDBOX=1 and an sk_test_
// key in .env.stripe-sandbox). Ordinary runs skip it and create nothing outside this machine.
// Evidence from it is `native_stripe_test`, never `era_integration`.
const SANDBOX_FILE = new URL("../../../.env.stripe-sandbox", import.meta.url);
const NATIVE = process.env.STRIPE_SANDBOX === "1" && existsSync(SANDBOX_FILE);

describe.skipIf(!NATIVE)("native Stripe test-mode refund writer", () => {
  it("refunds a controlled sandbox charge once, replays it idempotently and reads it back", {
    timeout: 90_000,
  }, async () => {
    process.loadEnvFile(SANDBOX_FILE);
    const client = sandboxClient();
    const runId = `t317${Date.now().toString(36)}`;
    const run = await seedSandbox(client, runId);
    const chargeId = run.chargeIds[2]; // seedSandbox refunds the second; the third is ours
    if (!chargeId) throw new Error("no third sandbox charge");
    const target: WriteTarget = {
      world: "rehearsal",
      config: { baseUrl: STRIPE_API, tenant: "native" },
      authorization: `Bearer ${sandboxKey()}`,
      transport: "native",
      accountId: run.accountId,
      headers: process.env.STRIPE_SANDBOX_API_VERSION
        ? { "stripe-version": process.env.STRIPE_SANDBOX_API_VERSION }
        : {},
      timeoutMs: 20_000,
    };
    const ctx = { world: "rehearsal", tenant: "native" } as const;
    const base = happyPathBundle().manifest.actions.find((a) => a.id === "refund_001");
    if (base?.kind !== "stripe.refund.create") throw new Error("fixture has no refund");
    const action = {
      ...base,
      args: { ...base.args, chargeId, amount: { amountMinor: 4210, currency: "cad" as const } },
    };

    const w = stripeWriter(target);
    expect(await w.preconditions?.(action, ctx)).toEqual({});
    const key = `op_${runId}`;
    const req = w.prepare(action, new Map(), key);
    const first = await w.dispatch(req, ctx);
    expect(first).toMatchObject({
      kind: "confirmed",
      body: { status: "succeeded", charge: chargeId },
    });
    const refundId = (first as { body: { id: string } }).body.id;

    // The identical bytes under the same key replay the original: still one refund.
    expect(await w.dispatch(req, ctx)).toMatchObject({ kind: "confirmed", body: { id: refundId } });

    const attempt: Attempt = {
      id: `att_${runId}`,
      actionId: action.id,
      planHash: "a".repeat(64),
      operationKey: key,
      attemptNo: 1,
      state: "unknown_outcome",
      request: {
        method: req.method,
        path: req.path,
        encoding: req.encoding,
        body: req.body,
        bodySha256: "b".repeat(64),
      },
      providerStatus: null,
      error: null,
      preparedAt: new Date().toISOString(),
      dispatchedAt: new Date().toISOString(),
      settledAt: null,
    };
    expect(await w.reconcile(attempt, action, ctx)).toMatchObject({
      kind: "applied",
      providerRef: { vendor: "stripe", kind: "refund", id: refundId },
    });
    const refunds = await client.get(`/v1/refunds?charge=${chargeId}&limit=100`);
    expect((refunds.data as unknown[]).length).toBe(1);
  });
});
