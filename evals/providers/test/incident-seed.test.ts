import type { WorldConfig } from "@rehearsal/providers";
import { incidentRecords } from "@rehearsal/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { incidentSnapshot, seedIncident } from "../../../scripts/seed/incident";
import {
  ENABLED,
  type EraVendor,
  getJson,
  resetScratchTenants,
  resetTenant,
  scratchWorld,
  uniqueTenant,
} from "../src/harness";

const { cases } = incidentRecords();
const VENDORS: EraVendor[] = ["stripe", "zendesk"];

// T1.2: reset → seed gives identical planning and operational worlds, every time.
describe.skipIf(!ENABLED)("seeded incident", () => {
  const tenant = uniqueTenant("incident");
  const worlds = {} as Record<EraVendor, { planning: WorldConfig; operational: WorldConfig }>;

  async function resetAndSeed(): Promise<Record<string, unknown>> {
    const snapshot: Record<string, unknown> = {};
    for (const vendor of VENDORS) {
      for (const world of ["planning", "operational"] as const) {
        await resetTenant(worlds[vendor][world]);
        await seedIncident(vendor, worlds[vendor][world]);
        snapshot[`${vendor}/${world}`] = await incidentSnapshot(vendor, worlds[vendor][world]);
      }
    }
    return snapshot;
  }

  let first: Record<string, unknown>;

  beforeAll(async () => {
    for (const vendor of VENDORS) {
      worlds[vendor] = {
        planning: await scratchWorld(vendor, "planning", tenant),
        operational: await scratchWorld(vendor, "operational", tenant),
      };
    }
    first = await resetAndSeed();
  });

  afterAll(resetScratchTenants);

  it("reads back identically in planning and operational", () => {
    expect(first["stripe/planning"]).toEqual(first["stripe/operational"]);
    expect(first["zendesk/planning"]).toEqual(first["zendesk/operational"]);
  });

  it("reproduces the same worlds after another reset", async () => {
    expect(await resetAndSeed()).toEqual(first);
  });

  it("puts each case where the incident predicate and the ticket link find it", async () => {
    const window = new URLSearchParams({
      "created[gte]": String(Date.parse("2026-09-01T00:00:00Z") / 1000),
      "created[lt]": String(Date.parse("2026-10-01T00:00:00Z") / 1000),
      limit: "100",
    });
    for (const c of cases) {
      const list = await getJson<{ data: Array<{ id: string }> }>(
        "stripe",
        worlds.stripe.planning,
        `/v1/charges?customer=${c.customerId}&${window}`,
      );
      const ids = list.data.map((charge) => charge.id);
      const expected = c.kind === "control_outside_window" ? [] : c.chargeIds;
      expect(c.chargeIds.filter((id) => ids.includes(id))).toEqual(expected);

      const { ticket } = await getJson<{ ticket: Record<string, unknown> }>(
        "zendesk",
        worlds.zendesk.planning,
        `/api/v2/tickets/${c.ticketId}.json`,
      );
      expect(ticket).toMatchObject({ external_id: c.customerId, requester_id: c.requesterId });
      // The requester is a real seeded end user.
      await getJson("zendesk", worlds.zendesk.planning, `/api/v2/users/${c.requesterId}.json`);
    }
  });
});
