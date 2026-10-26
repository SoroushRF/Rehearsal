import { CompanySnapshot } from "@rehearsal/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPANY_LIST_CAP,
  listCharges,
  listCustomers,
  listSlackMessages,
  listTickets,
} from "../src";

const target = {
  world: "operational",
  config: { baseUrl: "http://world.test", tenant: "test" },
  authorization: "Bearer test",
} as const;
afterEach(() => vi.restoreAllMocks());

/** Answers each request from `route(path)`; every requested path is recorded. */
function serve(route: (path: string) => unknown) {
  const paths: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const path = `${url.pathname}${url.search}`;
    paths.push(path);
    return Response.json(route(path));
  });
  return paths;
}

const charge = (n: number, currency = "cad") => ({
  id: `ch_${String(n).padStart(4, "0")}`,
  customer: `cus_${n % 3}`,
  amount: 4210,
  amount_refunded: n === 1 ? 4210 : 0,
  currency,
  invoice: n % 2 ? `in_${n}` : null,
  created: 1_759_300_000 + n,
  status: "succeeded",
});

describe("company list readers (#330)", () => {
  it("pages Stripe charges, maps them to the contract, and leaves out non-CAD ones", async () => {
    const all = [...Array.from({ length: 120 }, (_, i) => charge(i + 1)), charge(999, "usd")];
    const paths = serve((path) => {
      const params = new URL(`http://x${path}`).searchParams;
      const after = params.get("starting_after");
      const limit = Number(params.get("limit"));
      const start = after ? all.findIndex((c) => c.id === after) + 1 : 0;
      const data = all.slice(start, start + limit);
      return { data, has_more: start + limit < all.length };
    });
    const rows = await listCharges(target);
    expect(rows).toHaveLength(120);
    expect(rows.some((c) => c.id === "ch_0999")).toBe(false);
    expect(rows[0]).toEqual({
      id: "ch_0001",
      customer: "cus_1",
      invoice: "in_1",
      amountMinor: 4210,
      currency: "cad",
      created: new Date((1_759_300_000 + 1) * 1000).toISOString(),
      refundedMinor: 4210,
    });
    expect(paths[0]).toBe("/v1/charges?limit=100");
    // The other currency doesn't count toward the 200, and the scan stops at the end.
    expect(paths[1]).toBe("/v1/charges?limit=100&starting_after=ch_0100");
  });

  it("keeps scanning past other currencies, up to 20 pages", async () => {
    let n = 0;
    const paths = serve(() => ({
      data: Array.from({ length: 100 }, () => charge(++n, n % 50 === 0 ? "cad" : "usd")),
      has_more: true,
    }));
    const rows = await listCharges(target);
    expect(rows.every((c) => c.currency === "cad")).toBe(true);
    expect(rows).toHaveLength(40);
    expect(paths).toHaveLength(20);
  });

  it("caps every list at 200 rows", async () => {
    let n = 0;
    serve(() => ({ data: Array.from({ length: 100 }, () => charge(++n)), has_more: true }));
    expect(await listCharges(target, 500)).toHaveLength(COMPANY_LIST_CAP);
  });

  it("stops at a repeated or malformed page instead of looping", async () => {
    serve(() => ({ data: [charge(1)], has_more: true }));
    expect(await listCharges(target)).toHaveLength(1);
    vi.restoreAllMocks();
    serve(() => ({ nope: true }));
    expect(await listCustomers(target)).toEqual([]);
  });

  it("reads customers' balances in minor units", async () => {
    serve(() => ({
      data: [
        { id: "cus_1", email: "a@x.test", balance: -4210 },
        { id: "cus_2", email: null },
      ],
      has_more: false,
    }));
    expect(await listCustomers(target)).toEqual([
      { id: "cus_1", email: "a@x.test", balanceMinor: -4210 },
      { id: "cus_2", email: null, balanceMinor: 0 },
    ]);
  });

  it("follows Zendesk's next_page on the same origin only", async () => {
    const paths = serve((path) =>
      path.startsWith("/api/v2/tickets.json?per_page")
        ? {
            tickets: [
              {
                id: 7,
                subject: "Charged twice",
                status: "open",
                priority: "normal",
                requester_id: 41,
                updated_at: "2026-09-12T10:00:00Z",
              },
            ],
            next_page: "http://world.test/api/v2/tickets.json?page=2",
          }
        : path === "/api/v2/tickets.json?page=2"
          ? {
              tickets: [
                {
                  id: "8",
                  subject: null,
                  status: "new",
                  priority: null,
                  requester_id: null,
                  updated_at: "2026-09-13T10:00:00Z",
                },
              ],
              next_page: "http://elsewhere.test/api/v2/tickets.json?page=3",
            }
          : { tickets: [], next_page: null },
    );
    const tickets = await listTickets(target);
    expect(tickets).toEqual([
      {
        id: 7,
        subject: "Charged twice",
        status: "open",
        priority: "normal",
        requester: "41",
        updatedAt: "2026-09-12T10:00:00.000Z",
      },
      {
        id: 8,
        subject: "",
        status: "new",
        priority: null,
        requester: "",
        updatedAt: "2026-09-13T10:00:00.000Z",
      },
    ]);
    expect(paths).toHaveLength(2);
  });

  it("reads one Slack channel's history, following cursors once each", async () => {
    const paths = serve((path) =>
      path.includes("cursor=c2")
        ? {
            ok: true,
            messages: [{ ts: "1.2", text: "second" }],
            has_more: true,
            response_metadata: { next_cursor: "c2" },
          }
        : {
            ok: true,
            messages: [{ ts: "1.1", text: "Run summary" }],
            has_more: true,
            response_metadata: { next_cursor: "c2" },
          },
    );
    expect(await listSlackMessages(target, "C0SUMMARY")).toEqual([
      { ts: "1.1", channel: "C0SUMMARY", text: "Run summary" },
      { ts: "1.2", channel: "C0SUMMARY", text: "second" },
    ]);
    expect(paths).toHaveLength(2);
    vi.restoreAllMocks();
    serve(() => ({ ok: false, error: "channel_not_found" }));
    expect(await listSlackMessages(target, "C0NOPE")).toEqual([]);
  });

  it("produces rows the snapshot contract accepts", async () => {
    serve((path) =>
      path.startsWith("/v1/charges")
        ? { data: [charge(1)], has_more: false }
        : { data: [{ id: "cus_1", balance: 0 }], has_more: false },
    );
    const snapshot = {
      asOf: new Date().toISOString(),
      charges: await listCharges(target),
      customers: await listCustomers(target),
      tickets: [],
      slack: [],
      changed: {},
    };
    expect(CompanySnapshot.parse(snapshot)).toEqual(snapshot);
  });
});
