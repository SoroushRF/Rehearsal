import type { WorldConfig } from "@rehearsal/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ENABLED,
  type EraVendor,
  getJson,
  resetScratchTenants,
  resetTenant,
  SEED,
  scratchWorld,
  stripePost,
  uniqueTenant,
  zendeskPutTicket,
} from "../src/harness";

// Gate 2: the planning world and the operational world start identical. Separate containers
// with the same pinned image/seed/date/fidelity, compared through the same fresh tenant name.
const READS: Array<[EraVendor, string]> = [
  ["stripe", `/v1/charges/${SEED.chargeId}`],
  ["stripe", `/v1/customers/${SEED.customerId}`],
  ["stripe", `/v1/refunds?charge=${SEED.chargeId}`],
  ["stripe", `/v1/disputes?charge=${SEED.chargeId}`],
  ["stripe", `/v1/charges?customer=${SEED.customerId}&limit=100`],
  ["zendesk", `/api/v2/tickets/${SEED.ticketId}.json`],
  ["zendesk", `/api/v2/tickets/${SEED.ticketId}/comments.json`],
  ["zendesk", "/api/v2/tickets.json?per_page=100"],
];

describe.skipIf(!ENABLED)("baseline equality across planning and operational worlds", () => {
  const tenant = uniqueTenant("baseline");
  const worlds = {} as Record<EraVendor, { planning: WorldConfig; operational: WorldConfig }>;

  beforeAll(async () => {
    for (const vendor of ["stripe", "zendesk"] as const) {
      worlds[vendor] = {
        planning: await scratchWorld(vendor, "planning", tenant),
        operational: await scratchWorld(vendor, "operational", tenant),
      };
    }
  });

  afterAll(resetScratchTenants);

  // Pagination links (Zendesk next_page) embed the serving world's own origin; nothing else does.
  async function read(vendor: EraVendor, world: WorldConfig, path: string) {
    const json = JSON.stringify(await getJson(vendor, world, path));
    return JSON.parse(json.replaceAll(world.baseUrl, "<world>")) as unknown;
  }

  async function both(vendor: EraVendor, path: string) {
    return Promise.all([
      read(vendor, worlds[vendor].planning, path),
      read(vendor, worlds[vendor].operational, path),
    ]);
  }

  it.each(READS)("%s %s reads equal JSON (origin in links aside)", async (vendor, path) => {
    const [planning, operational] = await both(vendor, path);
    expect(planning).toEqual(operational);
  });

  it("a write in planning does not reach operational, and reset restores equality", async () => {
    const stripePlanning = worlds.stripe.planning;
    const zendeskPlanning = worlds.zendesk.planning;
    const chargePath = `/v1/charges/${SEED.chargeId}`;
    const ticketPath = `/api/v2/tickets/${SEED.ticketId}.json`;

    expect(
      (await stripePost(stripePlanning, "/v1/refunds", `charge=${SEED.chargeId}&amount=700`))
        .status,
    ).toBe(200);
    expect(
      (await zendeskPutTicket(zendeskPlanning, SEED.ticketId, { priority: "urgent" })).status,
    ).toBe(200);

    const [chargeP, chargeO] = (await both("stripe", chargePath)) as Array<{
      amount_refunded: number;
    }>;
    expect(chargeP?.amount_refunded).toBe(700);
    expect(chargeO?.amount_refunded).toBe(0);
    const [ticketP, ticketO] = (await both("zendesk", ticketPath)) as Array<{
      ticket: { priority: string };
    }>;
    expect(ticketP?.ticket.priority).toBe("urgent");
    expect(ticketO?.ticket.priority).not.toBe("urgent");

    await resetTenant(stripePlanning);
    await resetTenant(zendeskPlanning);
    for (const [vendor, path] of READS) {
      const [planning, operational] = await both(vendor, path);
      expect(planning, `${vendor} ${path} after reset`).toEqual(operational);
    }
  });
});
