import type { WorldConfig } from "@rehearsal/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ENABLED,
  type EraVendor,
  getJson,
  resetScratchTenants,
  resetTenant,
  scratchWorld,
  uniqueTenant,
} from "../../providers/src/harness";
import { loadSets } from "../src/sets";
import { seedSet, snapshotSet, type Worlds } from "../src/world";

const VENDORS: EraVendor[] = ["stripe", "zendesk"];
const WORLDS = ["planning", "operational"] as const;

// T4.14: each held-out set seeds the same planning and operational worlds on the pinned images,
// every time, and its records sit where the incident predicate and the ticket link find them.
describe.skipIf(!ENABLED).each(loadSets())("held-out set $id on Era", (set) => {
  const tenant = uniqueTenant(`held-out-${set.id}`);
  const worlds = {} as Record<(typeof WORLDS)[number], Worlds>;

  async function resetAndSeed(): Promise<Record<string, unknown>> {
    const snapshot: Record<string, unknown> = {};
    for (const world of WORLDS) {
      for (const vendor of VENDORS) await resetTenant(worlds[world][vendor]);
      await seedSet(set, worlds[world]);
      snapshot[world] = await snapshotSet(set, worlds[world]);
    }
    return snapshot;
  }

  let first: Record<string, unknown>;

  beforeAll(async () => {
    for (const world of WORLDS) {
      worlds[world] = {
        stripe: await scratchWorld("stripe", world, tenant),
        zendesk: await scratchWorld("zendesk", world, tenant),
      } as Worlds;
    }
    first = await resetAndSeed();
  }, 300_000);

  afterAll(resetScratchTenants);

  it("reads back identically in planning and operational", () => {
    expect(first.planning).toEqual(first.operational);
  });

  it("reproduces the same worlds after another reset", async () => {
    expect(await resetAndSeed()).toEqual(first);
  }, 300_000);

  it("puts each case where the incident predicate and the ticket link find it", async () => {
    const { createdGte, createdLt } = set.incident.window;
    const [gte, lt] = [createdGte, createdLt].map((iso) => Date.parse(iso) / 1000) as [
      number,
      number,
    ];
    const window = new URLSearchParams({
      "created[gte]": String(gte),
      "created[lt]": String(lt),
      limit: "100",
    });
    const created = new Map(
      set.records.stripe.charges.map((ch) => [String(ch.id), Number(ch.created)]),
    );
    const planning: WorldConfig = worlds.planning.stripe;
    for (const c of set.records.cases) {
      const list = await getJson<{ data: Array<{ id: string; status: string }> }>(
        "stripe",
        planning,
        `/v1/charges?customer=${c.customerId}&${window}`,
      );
      const ids = list.data.map((charge) => charge.id);
      const expected = c.chargeIds.filter((id) => {
        const at = created.get(id) as number;
        return at >= gte && at < lt;
      });
      expect(
        c.chargeIds.filter((id) => ids.includes(id)),
        c.key,
      ).toEqual(expected);
      if (c.kind === "control_failed_retry") {
        expect(list.data.find((ch) => ch.id === c.chargeIds[1])?.status, c.key).toBe("failed");
      }

      const customer = await getJson<{ currency: string | null }>(
        "stripe",
        planning,
        `/v1/customers/${c.customerId}`,
      );
      expect(customer.currency, c.key).toBe(c.billingCurrency ?? c.currency);

      const { ticket } = await getJson<{ ticket: Record<string, unknown> }>(
        "zendesk",
        worlds.planning.zendesk,
        `/api/v2/tickets/${c.ticketId}.json`,
      );
      expect(ticket, c.key).toMatchObject({
        external_id: c.ticketExternalId ?? c.customerId,
        requester_id: c.requesterId,
      });
      // The requester is a real seeded end user.
      await getJson("zendesk", worlds.planning.zendesk, `/api/v2/users/${c.requesterId}.json`);
    }
  });

  it("plants each setup step once, where the set says", () => {
    const snap = first.planning as Record<
      string,
      {
        charges: Array<{ id: string; amount: number; amount_refunded: number }>;
        credits: Array<{ amount: number; metadata: Record<string, string> }>;
      }
    >;
    for (const s of set.tasks.setup) {
      const c = set.records.cases.find((x) => x.key === s.caseKey);
      const chargeId = c?.chargeIds[s.charge];
      const got = snap[s.caseKey];
      if (s.kind === "refund_charge") {
        const charge = got?.charges.find((ch) => ch.id === chargeId);
        expect(charge?.amount_refunded, `${s.caseKey} refund`).toBe(charge?.amount);
      } else {
        expect(
          got?.credits.filter((t) => t.metadata?.charge === chargeId),
          `${s.caseKey} credit`,
        ).toEqual([expect.objectContaining({ amount: -(c?.amountMinor ?? 0) })]);
      }
    }
    // Nothing else is refunded or credited before planning starts.
    const planted = new Set(set.tasks.setup.map((s) => s.caseKey));
    for (const [key, got] of Object.entries(snap)) {
      if (planted.has(key)) continue;
      expect(
        got.charges.every((ch) => ch.amount_refunded === 0),
        `${key} refunded`,
      ).toBe(true);
      expect(got.credits, `${key} credited`).toEqual([]);
    }
  });
});
