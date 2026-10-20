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

interface Refund {
  id: string;
  amount: number;
  charge: string;
  currency: string;
  status: string;
  metadata: Record<string, string>;
}

interface Charge {
  amount: number;
  amount_refunded: number;
  currency: string;
  status: string;
  disputed: boolean;
  refunded: boolean;
}

// Gate 3: create a refund under an Idempotency-Key, refetch it, then resend the exact key and
// bytes. One economic effect. The simulator fingerprints path + raw body bytes.
describe.skipIf(!ENABLED)("Stripe refund idempotency", () => {
  let world: WorldConfig;
  const key = `rehearsal-op-${uniqueTenant("refund")}`;
  // Persisted exactly as dispatched; a retry must resend these bytes, not a re-encoding.
  const body = `charge=${SEED.chargeId}&amount=1000&currency=usd&metadata[rehearsal_op]=${key}`;
  let created: Refund;
  let createdRaw: string;

  const chargePath = `/v1/charges/${SEED.chargeId}`;
  const refundsPath = `/v1/refunds?charge=${SEED.chargeId}&limit=100`;

  beforeAll(async () => {
    world = await scratchWorld("stripe", "planning", uniqueTenant("refund"));
  });

  afterAll(resetScratchTenants);

  it("starts from a succeeded, unrefunded, undisputed USD charge", async () => {
    const charge = await getJson<Charge>("stripe", world, chargePath);
    expect(charge).toMatchObject({
      status: "succeeded",
      amount_refunded: 0,
      currency: "usd",
      disputed: false,
    });
    expect((await getJson<{ data: Refund[] }>("stripe", world, refundsPath)).data).toEqual([]);
  });

  it("creates the refund and reads it back", async () => {
    const res = await stripePost(world, "/v1/refunds", body, key);
    expect(res.status).toBe(200);
    expect(res.headers.get("idempotency-key")).toBe(key);
    expect(res.headers.get("idempotent-replayed")).toBeNull();
    createdRaw = await res.text();
    created = JSON.parse(createdRaw) as Refund;
    expect(created).toMatchObject({
      amount: 1000,
      charge: SEED.chargeId,
      currency: "usd",
      metadata: { rehearsal_op: key },
    });
    expect(created.id).toMatch(/^re_[A-Za-z0-9]{16}$/);
    // Simulator simplification: creation is always immediately "succeeded".
    expect(created.status).toBe("succeeded");

    expect(await getJson("stripe", world, `/v1/refunds/${created.id}`)).toEqual(created);
    expect((await getJson<Charge>("stripe", world, chargePath)).amount_refunded).toBe(1000);
  });

  it("replays the same key and bytes without a second effect", async () => {
    const res = await stripePost(world, "/v1/refunds", body, key);
    expect(res.status).toBe(200);
    expect(res.headers.get("idempotent-replayed")).toBe("true");
    expect(await res.text()).toBe(createdRaw);

    const refunds = (await getJson<{ data: Refund[] }>("stripe", world, refundsPath)).data;
    expect(refunds.map((r) => r.id)).toEqual([created.id]);
    const charge = await getJson<Charge>("stripe", world, chargePath);
    expect(charge.amount_refunded).toBe(1000);
    expect(charge.refunded).toBe(false);
  });

  it("rejects the same key with different bytes, even a mere field reorder", async () => {
    const changed = body.replace("amount=1000", "amount=1001");
    const reordered = `amount=1000&charge=${SEED.chargeId}&currency=usd&metadata[rehearsal_op]=${key}`;
    for (const variant of [changed, reordered]) {
      const res = await stripePost(world, "/v1/refunds", variant, key);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { type: string } }).error.type).toBe(
        "idempotency_error",
      );
    }
    expect((await getJson<{ data: Refund[] }>("stripe", world, refundsPath)).data).toHaveLength(1);
    expect((await getJson<Charge>("stripe", world, chargePath)).amount_refunded).toBe(1000);
  });

  it("scopes the idempotency cache per tenant, and twin tenants mint the same refund ID", async () => {
    const twin = await scratchWorld("stripe", "planning", uniqueTenant("refund-twin"));
    const res = await stripePost(twin, "/v1/refunds", body, key);
    expect(res.status).toBe(200);
    // A separate effect in the other tenant, not a replay...
    expect(res.headers.get("idempotent-replayed")).toBeNull();
    expect((await getJson<Charge>("stripe", twin, chargePath)).amount_refunded).toBe(1000);
    // ...but with an identical ID: IDs come from seed/state/counter, not tenant or world. A
    // remapper test must force divergence or it cannot tell rehearsal IDs from applied ones.
    expect(((await res.json()) as Refund).id).toBe(created.id);
  });
});
