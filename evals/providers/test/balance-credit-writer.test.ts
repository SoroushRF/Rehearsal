import type { Attempt } from "@rehearsal/contracts";
import type { CreditAction } from "@rehearsal/core";
import { stripeCreditWriter, type WorldConfig, type WriteTarget } from "@rehearsal/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ENABLED,
  getJson,
  resetScratchTenants,
  SEED,
  scratchWorld,
  stripePost,
  uniqueTenant,
} from "../src/harness";

interface Customer {
  id: string;
  currency: string | null;
  balance: number;
}

/**
 * T3.12 on Era: the credit is a negative customer balance transaction with the operation key as
 * idempotency key and metadata; a lost response is found by that key in the customer's list; a
 * customer in another currency is refused before anything is prepared (Era itself would accept it).
 */
describe.skipIf(!ENABLED)("Stripe balance credit writer on Era", () => {
  let world: WorldConfig;
  let target: WriteTarget;
  let customer: Customer;
  const ctx = () => ({ world: "operational", tenant: world.tenant }) as const;
  const credit = (customerId: string): CreditAction => ({
    id: "credit_001",
    kind: "stripe.customer.balanceCredit",
    args: {
      customerId,
      chargeId: "ch_rehearsal_dup",
      amount: { amountMinor: 1500, currency: "cad" },
    },
  });
  const attemptOf = (operationKey: string, body: string, customerId: string): Attempt => ({
    id: `att_${operationKey}`,
    actionId: "credit_001",
    planHash: "a".repeat(64),
    operationKey,
    attemptNo: 1,
    state: "unknown_outcome",
    request: {
      method: "POST",
      path: `/v1/customers/${customerId}/balance_transactions`,
      encoding: "form",
      body,
      bodySha256: "b".repeat(64),
    },
    providerStatus: null,
    error: null,
    preparedAt: new Date().toISOString(),
    dispatchedAt: new Date().toISOString(),
    settledAt: null,
  });
  const transactions = async (id: string) =>
    (
      await getJson<{ data: { id: string; metadata: Record<string, string> }[] }>(
        "stripe",
        world,
        `/v1/customers/${id}/balance_transactions?limit=100`,
      )
    ).data;
  const balance = async (id: string) =>
    (await getJson<Customer>("stripe", world, `/v1/customers/${id}`)).balance;

  beforeAll(async () => {
    world = await scratchWorld("stripe", "operational", uniqueTenant("creditw"));
    target = {
      world: "operational",
      config: world,
      authorization: "Bearer sk_test_rehearsal_conformance",
    };
    const res = await stripePost(
      world,
      "/v1/customers",
      "email=credit%40example.com",
      uniqueTenant("cus"),
    );
    expect(res.status).toBe(200);
    customer = (await res.json()) as Customer;
  });
  afterAll(resetScratchTenants);

  it("refuses a credit in another currency than the customer's, before preparing it", async () => {
    const usd = await getJson<Customer>("stripe", world, `/v1/customers/${SEED.customerId}`);
    expect(usd.currency).toBe("usd");
    await expect(
      stripeCreditWriter(target).preconditions(credit(SEED.customerId), ctx()),
    ).rejects.toThrow(/is in usd, the credit is in cad/);
  });

  it("credits a customer, moves the balance and reads the credit back by its key", async () => {
    const key = `op_${uniqueTenant("credit")}`;
    const w = stripeCreditWriter(target);
    const action = credit(customer.id);
    expect(customer.currency).toBeNull();
    await w.preconditions(action, ctx());
    const req = w.prepare(action, key);
    const sent = await w.dispatch(req, ctx());
    expect(sent).toMatchObject({
      kind: "confirmed",
      body: {
        amount: -1500,
        currency: "cad",
        type: "adjustment",
        metadata: { charge: "ch_rehearsal_dup" },
      },
    });
    const id = (sent as { body: { id: string } }).body.id;
    expect(await w.reconcile(attemptOf(key, req.body, customer.id), action, ctx())).toEqual({
      kind: "applied",
      providerRef: { vendor: "stripe", kind: "customer_balance_transaction", id },
      effect: {
        "credit.id": id,
        "credit.amount": -1500,
        "credit.type": "adjustment",
        "credit.charge": "ch_rehearsal_dup",
        customer: customer.id,
        currency: "cad",
      },
    });
    expect(await balance(customer.id)).toBe(-1500);

    // The identical replay (same key and bytes) returns the original: still one credit.
    expect(await w.dispatch(req, ctx())).toMatchObject({ kind: "confirmed", body: { id } });
    expect(
      (await transactions(customer.id)).filter((t) => t.metadata.rehearsal_op === key),
    ).toHaveLength(1);
    expect(await balance(customer.id)).toBe(-1500);
  });

  it("resolves a credit whose response was lost by reading the customer's transactions", async () => {
    const key = `op_${uniqueTenant("lost")}`;
    const w = stripeCreditWriter(target);
    const action = credit(customer.id);
    const req = w.prepare(action, key);
    const before = await balance(customer.id);
    await w.dispatch(req, ctx()); // lands; the test drops its response
    expect((await w.reconcile(attemptOf(key, req.body, customer.id), action, ctx())).kind).toBe(
      "applied",
    );
    expect(await balance(customer.id)).toBe(before - 1500);
  });

  it("reads a credit that never went out as not applied", async () => {
    const key = `op_${uniqueTenant("never")}`;
    const w = stripeCreditWriter(target);
    const action = credit(customer.id);
    expect(
      await w.reconcile(attemptOf(key, w.prepare(action, key).body, customer.id), action, ctx()),
    ).toEqual({
      kind: "not_applied",
    });
  });

  it("refuses the same key with other bytes as a definite refusal, adding nothing", async () => {
    const key = `op_${uniqueTenant("bytes")}`;
    const w = stripeCreditWriter(target);
    await w.dispatch(w.prepare(credit(customer.id), key), ctx());
    const other = {
      ...credit(customer.id),
      args: { ...credit(customer.id).args, amount: { amountMinor: 1600, currency: "cad" } },
    };
    expect(await w.dispatch(w.prepare(other, key), ctx())).toMatchObject({
      kind: "rejected",
      status: 400,
      retryable: false,
    });
    expect(
      (await transactions(customer.id)).filter((t) => t.metadata.rehearsal_op === key),
    ).toHaveLength(1);
  });
});
