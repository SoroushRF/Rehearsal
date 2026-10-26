import { CompanySnapshot, ReplayBundle, Sha256Hex, StoredIncident } from "@rehearsal/contracts";
import { z } from "zod";

/**
 * The shared fixture bundles in `scenarios/billing/cases`, as written by `pnpm fixtures:write`.
 * Their plan hash was computed by `@rehearsal/core` when they were written; the browser shows it
 * and never re-derives it. Real plans replace these once `GET /api/plans/:id` lands (T2.2).
 */
const BundleFile = z.object({ planHash: Sha256Hex, bundle: ReplayBundle });
export type FixtureBundle = z.infer<typeof BundleFile>;

const files = import.meta.glob("../../../scenarios/billing/cases/*.bundle.json", {
  eager: true,
  import: "default",
});

/** Parses at load so a drifted fixture fails loudly instead of rendering half a plan. */
export const fixtureBundles: FixtureBundle[] = Object.entries(files)
  .map(([path, json]) => {
    const parsed = BundleFile.safeParse(json);
    if (!parsed.success) throw new Error(`invalid fixture bundle ${path}: ${parsed.error.message}`);
    return parsed.data;
  })
  .sort((a, b) => order(a.bundle.id) - order(b.bundle.id));

/** Demo order: the happy path first, then the hero moments. */
function order(id: string) {
  const i = ["happy-path", "phantom", "teammate-conflict", "unknown-outcome"].indexOf(id);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

/**
 * A company as `GET /api/company` returns it, for building and testing the overview before the
 * route is deployed. Shown only labelled `fixture`. Two customers were charged twice for the same
 * September invoice; one of them has been refunded and credited by `run_fixture_01`.
 */
export const companyFixture: CompanySnapshot = CompanySnapshot.parse({
  asOf: "2026-10-25T14:00:00.000Z",
  charges: [
    charge("ch_3Q8aD1", "cus_aG8yCbh8", "in_1Q7Rk2", 4210, "2026-09-27T15:02:11Z", 4210),
    charge("ch_3Q8aC9", "cus_aG8yCbh8", "in_1Q7Rk2", 4210, "2026-09-27T15:02:09Z", 0),
    charge("ch_3Q8b7M", "cus_RMvYIuFP", "in_1Q7Sx0", 12900, "2026-09-27T15:04:40Z", 0),
    charge("ch_3Q8b7K", "cus_RMvYIuFP", "in_1Q7Sx0", 12900, "2026-09-27T15:04:38Z", 0),
    charge("ch_3Q8c2P", "cus_daHOXjLn", "in_1Q7Tb4", 2500, "2026-09-28T09:11:02Z", 0),
    charge("ch_3Q7zQ1", "cus_dg63haxJ", null, 8800, "2026-09-12T18:40:55Z", 0),
  ],
  customers: [
    { id: "cus_aG8yCbh8", email: "maya@northwind.example", balanceMinor: -500 },
    { id: "cus_RMvYIuFP", email: "ops@harbor-labs.example", balanceMinor: 0 },
    { id: "cus_daHOXjLn", email: "li.wei@example.com", balanceMinor: 0 },
    { id: "cus_dg63haxJ", email: null, balanceMinor: 1200 },
  ],
  tickets: [
    ticket(4102, "Charged twice for September", "open", "urgent", "maya@northwind.example"),
    ticket(4107, "Duplicate charge on invoice in_1Q7Sx0", "new", "high", "ops@harbor-labs.example"),
    ticket(4110, "Where is my receipt?", "pending", "low", "li.wei@example.com"),
  ],
  slack: [
    {
      ts: "1761400800.000100",
      channel: "#billing-ops",
      text: "Run run_fixture_01: 1 refund, 1 credit, 1 note. 0 held.",
    },
    { ts: "1761314400.000200", channel: "#billing-ops", text: "Seeing double charges on 9/27." },
  ],
  changed: {
    ch_3Q8aD1: "run_fixture_01",
    cus_aG8yCbh8: "run_fixture_01",
    "4102": "run_fixture_01",
    "1761400800.000100": "run_fixture_01",
  },
});

/** Incidents as `GET /api/incidents` returns them, newest first. */
export const incidentFixtures: StoredIncident[] = z.array(StoredIncident).parse([
  {
    incidentId: "INC-BILL-1031",
    orgId: "org_fixture",
    kind: "duplicate_charge",
    title: "Second batch of double charges",
    description: "Harbor Labs reports invoice in_1Q7Sx0 was charged twice on Sep 27.",
    window: { createdGte: "2026-09-01T00:00:00.000Z", createdLt: "2026-10-01T00:00:00.000Z" },
    createdAt: "2026-10-25T13:40:00.000Z",
  },
  {
    incidentId: "INC-BILL-0927",
    orgId: "org_fixture",
    kind: "duplicate_charge",
    title: "September duplicate charges",
    description: "Customers charged twice for the same September invoice.",
    window: { createdGte: "2026-09-01T00:00:00.000Z", createdLt: "2026-10-01T00:00:00.000Z" },
    createdAt: "2026-10-24T18:00:00.000Z",
  },
]);

function charge(
  id: string,
  customer: string,
  invoice: string | null,
  amountMinor: number,
  created: string,
  refundedMinor: number,
) {
  return { id, customer, invoice, amountMinor, currency: "cad", created, refundedMinor };
}

function ticket(id: number, subject: string, status: string, priority: string, requester: string) {
  return { id, subject, status, priority, requester, updatedAt: "2026-10-25T13:58:00Z" };
}
