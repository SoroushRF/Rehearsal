import { readFileSync } from "node:fs";
import type { QueryPredicate } from "@rehearsal/contracts";
import {
  eraAdmin,
  type ProviderReader,
  stripeReader,
  type WorldConfig,
  zendeskReader,
} from "@rehearsal/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminToken,
  ENABLED,
  resetScratchTenants,
  SEED,
  scratchWorld,
  uniqueTenant,
} from "../src/harness";

const template = JSON.parse(
  readFileSync(
    new URL("../../../scenarios/billing/fixtures/stripe.charge.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

// T1.3: the read adapters against the pinned images. The seeded charge was created 2026-08-31;
// a page size of 1 forces real pagination once a second matching charge is injected.
describe.skipIf(!ENABLED)("read adapters", () => {
  const tenant = uniqueTenant("read");
  const ctx = { world: "planning", tenant } as const;
  const august: QueryPredicate = {
    kind: "stripe.charges.byCustomerInWindow",
    customerId: SEED.customerId,
    createdGte: "2026-08-01T00:00:00Z",
    createdLt: "2026-09-01T00:00:00Z",
  };
  let stripeWorld: WorldConfig;
  let stripe: ProviderReader;
  let zendesk: ProviderReader;

  beforeAll(async () => {
    stripeWorld = await scratchWorld("stripe", "planning", tenant);
    const zendeskWorld = await scratchWorld("zendesk", "planning", tenant);
    const auth = { world: "planning", pageSize: 1 } as const;
    stripe = stripeReader({ ...auth, config: stripeWorld, authorization: "Bearer sk_test_read" });
    zendesk = zendeskReader({ ...auth, config: zendeskWorld, authorization: "Bearer read" });
  });

  afterAll(resetScratchTenants);

  it("observes the seeded charge and ticket", async () => {
    const charge = await stripe.observe(
      { vendor: "stripe", kind: "charge", id: SEED.chargeId },
      ctx,
    );
    expect(charge.projection).toMatchObject({ customer: SEED.customerId, amount_refunded: 0 });
    const ticket = await zendesk.observe(
      { vendor: "zendesk", kind: "ticket", id: String(SEED.ticketId) },
      ctx,
    );
    expect(ticket.projection).toMatchObject({ id: String(SEED.ticketId), status: "open" });
  });

  it("enumerates every page of a requester's tickets", async () => {
    const q = await zendesk.query(
      { kind: "zendesk.tickets.byRequester", requesterId: "2000051" },
      new Date().toISOString(),
      ctx,
    );
    expect(q.complete).toBe(true);
    expect(q.matchingIds).toHaveLength(6);
    expect(q.matchingIds).toContain(String(SEED.ticketId));
  });

  it("sees a newly injected matching charge (a phantom), but not one outside the window", async () => {
    const before = await stripe.query(august, new Date().toISOString(), ctx);
    expect(before).toMatchObject({ complete: true, matchingIds: [SEED.chargeId] });

    const created = template.created as number;
    const res = await eraAdmin(stripeWorld, adminToken(), "/inject", {
      charges: [
        { ...template, id: "ch_rehearsalPhantom1", created: created - 3600 },
        { ...template, id: "ch_rehearsalControl1", created: 1_788_220_800 },
      ],
    });
    expect(res.status).toBe(200);

    const after = await stripe.query(august, new Date().toISOString(), ctx);
    expect(after.complete).toBe(true);
    expect(after.matchingIds).toEqual(["ch_rehearsalPhantom1", SEED.chargeId].sort());
  });
});
