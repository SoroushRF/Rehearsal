import { resolveWorld, type WorldConfig } from "@rehearsal/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ENABLED,
  getJson,
  getTicket,
  resetScratchTenants,
  resetTenant,
  SEED,
  scratchWorld,
  stripePost,
  uniqueTenant,
  zendeskPutTicket,
} from "../src/harness";

const chargePath = `/v1/charges/${SEED.chargeId}`;
const refundsPath = `/v1/refunds?charge=${SEED.chargeId}&limit=100`;

async function amountRefunded(world: WorldConfig): Promise<number> {
  return (await getJson<{ amount_refunded: number }>("stripe", world, chargePath)).amount_refunded;
}

async function refundCount(world: WorldConfig): Promise<number> {
  return (await getJson<{ data: unknown[] }>("stripe", world, refundsPath)).data.length;
}

// Gate 2 (cont.): tenants within one world are isolated, and /_admin/tenants/{T}/reset drops a
// tenant's client writes. Tenants are selected by an operator-minted signed token: these images
// ignore a plaintext X-Sim-Tenant from clients once SIMCORE_ADMIN_TOKEN is configured.
describe.skipIf(!ENABLED)("tenant isolation and reset", () => {
  const nameA = uniqueTenant("tenant-a");
  const nameB = uniqueTenant("tenant-b");
  let stripeA: WorldConfig;
  let stripeB: WorldConfig;
  let zendeskA: WorldConfig;
  let zendeskB: WorldConfig;
  const key = `rehearsal-op-${nameA}`;
  const body = `charge=${SEED.chargeId}&amount=2500`;
  let seedPriority: string | null;

  beforeAll(async () => {
    stripeA = await scratchWorld("stripe", "planning", nameA);
    stripeB = await scratchWorld("stripe", "planning", nameB);
    zendeskA = await scratchWorld("zendesk", "planning", nameA);
    zendeskB = await scratchWorld("zendesk", "planning", nameB);
    seedPriority = (await getTicket(zendeskA, SEED.ticketId)).priority;
  });

  afterAll(resetScratchTenants);

  it("keeps tenant A's writes invisible to tenant B", async () => {
    expect((await stripePost(stripeA, "/v1/refunds", body, key)).status).toBe(200);
    expect((await zendeskPutTicket(zendeskA, SEED.ticketId, { priority: "urgent" })).status).toBe(
      200,
    );

    expect(await amountRefunded(stripeA)).toBe(2500);
    expect(await refundCount(stripeA)).toBe(1);
    expect((await getTicket(zendeskA, SEED.ticketId)).priority).toBe("urgent");

    expect(await amountRefunded(stripeB)).toBe(0);
    expect(await refundCount(stripeB)).toBe(0);
    expect((await getTicket(zendeskB, SEED.ticketId)).priority).toBe(seedPriority);
  });

  it("ignores a plaintext X-Sim-Tenant: a client naming tenant A lands in default", async () => {
    // Read-only against "default" (which other local work may have touched, so compare views
    // rather than assume it is pristine): the unsigned name sees default's data, not A's.
    const stripeWorld = resolveWorld("stripe", "planning");
    const plaintextA: WorldConfig = { ...stripeWorld, tenant: nameA };
    const defaultView: WorldConfig = { ...stripeWorld, tenant: "default" };
    expect(plaintextA.tenantToken).toBeUndefined();
    const seenAsA = await getJson("stripe", plaintextA, refundsPath);
    expect(seenAsA).toEqual(await getJson("stripe", defaultView, refundsPath));
    expect(seenAsA).not.toEqual(await getJson("stripe", stripeA, refundsPath));

    const zendeskWorld = resolveWorld("zendesk", "planning");
    const ticketAsA = await getTicket({ ...zendeskWorld, tenant: nameA }, SEED.ticketId);
    expect(ticketAsA).toEqual(
      await getTicket({ ...zendeskWorld, tenant: "default" }, SEED.ticketId),
    );
    expect(ticketAsA.priority).not.toBe("urgent");
  });

  it("refuses tenant minting and /_admin without the operator credential", async () => {
    const { baseUrl } = stripeA;
    const mint = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "intruder",
        client_secret: "x",
        tenant: nameA,
      }),
    });
    expect(mint.status).toBe(403);
    expect(await mint.json()).toMatchObject({ error: "access_denied" });

    const reset = await fetch(`${baseUrl}/_admin/tenants/${nameA}/reset`, { method: "POST" });
    expect(reset.status).toBe(401);
    expect(await reset.json()).toMatchObject({ error: "admin_unauthorized" });
  });

  it("drops A's writes on reset, leaves B alone, and keeps A's token valid", async () => {
    await resetTenant(stripeA);
    await resetTenant(zendeskA);

    expect(await amountRefunded(stripeA)).toBe(0);
    expect(await refundCount(stripeA)).toBe(0);
    expect((await getTicket(zendeskA, SEED.ticketId)).priority).toBe(seedPriority);
    expect(await amountRefunded(stripeB)).toBe(0);
  });

  it("forgets idempotency keys on reset: the same key and bytes refund again", async () => {
    // Never reset a world an executor is mid-plan in: a retry after reset is a new effect.
    const res = await stripePost(stripeA, "/v1/refunds", body, key);
    expect(res.status).toBe(200);
    expect(res.headers.get("idempotent-replayed")).toBeNull();
    expect(await amountRefunded(stripeA)).toBe(2500);
  });
});
