import type { WorldConfig } from "@rehearsal/providers";
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

interface BalanceTransaction {
  id: string;
  object: string;
  amount: number;
  currency: string;
  customer: string;
  ending_balance: number;
  type: string;
  metadata: Record<string, string>;
}

interface Customer {
  currency: string | null;
  balance: number;
}

// T1.19: the semantics `stripe.customer.balanceCredit` relies on. A credit is a negative customer
// balance transaction. Idempotency and read-back must match the refund gate (c, c′), and the
// fidelity gaps are asserted so a simulator change shows up here.
describe.skipIf(!ENABLED)("Stripe customer balance credit", () => {
  let world: WorldConfig;
  const key = `rehearsal-op-${uniqueTenant("credit")}`;
  const body = `amount=-1500&currency=usd&metadata[rehearsal_op]=${key}`;
  const path = `/v1/customers/${SEED.customerId}/balance_transactions`;
  let created: BalanceTransaction;
  let createdRaw: string;

  beforeAll(async () => {
    world = await scratchWorld("stripe", "planning", uniqueTenant("credit"));
  });

  afterAll(resetScratchTenants);

  it("starts from a USD customer with a zero balance and no transactions", async () => {
    const customer = await getJson<Customer>("stripe", world, `/v1/customers/${SEED.customerId}`);
    expect(customer).toMatchObject({ currency: "usd", balance: 0 });
    expect((await getJson<{ data: unknown[] }>("stripe", world, path)).data).toEqual([]);
  });

  it("creates the credit, moves the balance and reads it back", async () => {
    const res = await stripePost(world, path, body, key);
    expect(res.status).toBe(200);
    expect(res.headers.get("idempotent-replayed")).toBeNull();
    createdRaw = await res.text();
    created = JSON.parse(createdRaw) as BalanceTransaction;
    expect(created).toMatchObject({
      object: "customer_balance_transaction",
      amount: -1500,
      currency: "usd",
      customer: SEED.customerId,
      ending_balance: -1500,
      type: "adjustment",
      metadata: { rehearsal_op: key },
    });
    expect(created.id).toMatch(/^cbtxn_[A-Za-z0-9]{16}$/);

    expect(await getJson("stripe", world, `${path}/${created.id}`)).toEqual(created);
    const customer = await getJson<Customer>("stripe", world, `/v1/customers/${SEED.customerId}`);
    expect(customer.balance).toBe(-1500);
  });

  it("replays the same key and bytes without a second credit", async () => {
    const res = await stripePost(world, path, body, key);
    expect(res.status).toBe(200);
    expect(res.headers.get("idempotent-replayed")).toBe("true");
    expect(await res.text()).toBe(createdRaw);
    const list = await getJson<{ data: BalanceTransaction[] }>("stripe", world, path);
    expect(list.data.map((t) => t.id)).toEqual([created.id]);
    expect(
      (await getJson<Customer>("stripe", world, `/v1/customers/${SEED.customerId}`)).balance,
    ).toBe(-1500);
  });

  it("rejects the same key with different bytes", async () => {
    const res = await stripePost(world, path, body.replace("-1500", "-1600"), key);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe(
      "idempotency_error",
    );
    expect((await getJson<{ data: unknown[] }>("stripe", world, path)).data).toHaveLength(1);
  });

  it("finds a lost credit by its marker in the customer's list, and only under that customer", async () => {
    const list = await getJson<{ data: BalanceTransaction[] }>(
      "stripe",
      world,
      `${path}?limit=100`,
    );
    expect(list.data.filter((t) => t.metadata.rehearsal_op === key).map((t) => t.id)).toEqual([
      created.id,
    ]);
    const other = await stripePost(
      world,
      "/v1/customers/cus_doesnotexist0000/balance_transactions",
      "amount=-100&currency=usd",
      `${key}-missing`,
    );
    expect(other.status).toBe(404);
  });

  // Fidelity gaps. Stripe keeps a balance in the customer's currency and refuses others; Era
  // takes any currency and sums them into one number, and also takes a zero amount. Our side
  // must check the customer's currency and send only positive credits.
  it("accepts a credit in a currency other than the customer's, and a zero amount", async () => {
    const eur = await stripePost(world, path, "amount=-100&currency=eur", `${key}-eur`);
    expect(eur.status).toBe(200);
    expect(((await eur.json()) as BalanceTransaction).ending_balance).toBe(-1600);
    const zero = await stripePost(world, path, "amount=0&currency=usd", `${key}-zero`);
    expect(zero.status).toBe(200);
  });
});
