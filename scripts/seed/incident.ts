import { isDeepStrictEqual } from "node:util";
import type { WorldConfig } from "@rehearsal/providers";
import { incidentRecords } from "@rehearsal/testkit";
import { adminOrThrow, type EraVendor, getJson } from "../inject/session";

/**
 * T1.2: plant the INC-BILL-0927 cohort (scenarios/billing/incident.v1.json) in a world, and read
 * back what the planner and executor will see, so both worlds can be compared after a reset.
 */

export async function seedIncident(vendor: EraVendor, world: WorldConfig): Promise<void> {
  const records = incidentRecords();
  await adminOrThrow(world, "/inject", vendor === "stripe" ? records.stripe : records.zendesk);
}

/** Every cohort customer's charges, and every cohort ticket with its comments. */
export async function incidentSnapshot(vendor: EraVendor, world: WorldConfig): Promise<unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const c of incidentRecords().cases) {
    if (vendor === "stripe") {
      const path = `/v1/charges?customer=${c.customerId}&limit=100`;
      const list = await getJson<{ data: unknown[]; has_more: boolean }>(vendor, world, path);
      if (list.has_more) throw new Error(`${c.customerId} has more than 100 charges`);
      snapshot[c.customerId] = list.data;
    } else {
      const base = `/api/v2/tickets/${c.ticketId}`;
      snapshot[c.ticketId] = {
        ticket: await getJson(vendor, world, `${base}.json`),
        comments: (await getJson<{ comments: unknown }>(vendor, world, `${base}/comments.json`))
          .comments,
      };
    }
  }
  return snapshot;
}

/** Seeded records match between worlds (and the cohort is actually there). */
export async function compareWorlds(
  vendor: EraVendor,
  planning: WorldConfig,
  operational: WorldConfig,
): Promise<[boolean, string]> {
  const [a, b] = await Promise.all([
    incidentSnapshot(vendor, planning),
    incidentSnapshot(vendor, operational),
  ]);
  const cases = incidentRecords().cases.length;
  return [
    isDeepStrictEqual(a, b) && Object.keys(a as object).length === cases,
    `${vendor}: ${cases} incident cases identical in planning and operational`,
  ];
}
