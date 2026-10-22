import { readFileSync } from "node:fs";
import type { QueryPredicate } from "@rehearsal/contracts";
import { FakeClock } from "@rehearsal/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ReadTarget, stripeReader, zendeskReader } from "../src";

// Recorded GET responses from a fresh tenant of the pinned planning world (seed 42, day1).
const recorded = (name: string) =>
  JSON.parse(readFileSync(new URL(`./recorded/${name}`, import.meta.url), "utf8"));
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../scenarios/billing/fixtures/${name}`, import.meta.url), "utf8"),
  );

const ctx = { world: "planning", tenant: "rehearsal-demo" } as const;
const target = (overrides: Partial<ReadTarget> = {}): ReadTarget => ({
  world: "planning",
  config: { baseUrl: "http://127.0.0.1:8111", tenant: "rehearsal-demo", tenantToken: "jwt" },
  authorization: "Bearer test",
  clock: new FakeClock(),
  ...overrides,
});

/** Serve responses in order; record the paths asked for. */
function serve(...bodies: Array<unknown | Response>) {
  const paths: string[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    paths.push(new URL(String(input)).pathname + new URL(String(input)).search);
    const next = bodies.shift();
    if (next === undefined) throw new Error("unexpected request");
    return next instanceof Response ? next : Response.json(next);
  });
  return { paths, spy };
}

afterEach(() => vi.restoreAllMocks());

const CUSTOMER = "cus_necGym2uIJ94j40b";
const CHARGE = "ch_7wD2ja8lIorW65Uh";
const august: QueryPredicate = {
  kind: "stripe.charges.byCustomerInWindow",
  customerId: CUSTOMER,
  createdGte: "2026-08-01T00:00:00Z",
  createdLt: "2026-09-01T00:00:00Z",
};
const byRequester: QueryPredicate = { kind: "zendesk.tickets.byRequester", requesterId: "2000051" };
const CUTOFF = "2026-10-01T12:00:00.000Z";

describe("stripeReader", () => {
  it("observes a charge as its v1 projection", async () => {
    serve(fixture("stripe.charge.json"));
    const obs = await stripeReader(target()).observe(
      { vendor: "stripe", kind: "charge", id: CHARGE },
      ctx,
    );
    expect(obs).toMatchObject({
      id: `obs_charge_${CHARGE}`,
      world: "planning",
      projectionVersion: "stripe.charge.v2",
      projection: {
        id: CHARGE,
        customer: CUSTOMER,
        amount: 42083,
        amount_refunded: 0,
        currency: "usd",
        status: "succeeded",
      },
      capturedAt: "2026-10-01T12:00:00.000Z",
    });
    expect(obs.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("queries a customer's charges in the window, sending the window to the server", async () => {
    const { paths } = serve(recorded("stripe.charges.by-customer.json"));
    const q = await stripeReader(target()).query(august, CUTOFF, ctx);
    expect(q).toMatchObject({ complete: true, matchingIds: [CHARGE], cutoff: CUTOFF });
    expect(q.projections[CHARGE]).toMatchObject({ amount: 42083, customer: CUSTOMER });
    const params = new URLSearchParams(paths[0]?.split("?")[1]);
    expect(params.get("customer")).toBe(CUSTOMER);
    expect(params.get("created[gte]")).toBe("1785542400");
    expect(params.get("created[lt]")).toBe("1788220800");
  });

  it("follows starting_after across pages and drops records outside the predicate", async () => {
    const [charge] = recorded("stripe.charges.by-customer.json").data;
    const second = { ...charge, id: "ch_second", created: charge.created - 60 };
    const outside = { ...charge, id: "ch_outside", created: 1_788_220_800 };
    const { paths } = serve(
      { object: "list", data: [charge], has_more: true },
      { object: "list", data: [second, outside], has_more: false },
    );
    const q = await stripeReader(target({ pageSize: 1 })).query(august, CUTOFF, ctx);
    expect(q.complete).toBe(true);
    expect(q.matchingIds).toEqual([CHARGE, "ch_second"].sort());
    expect(new URLSearchParams(paths[1]?.split("?")[1]).get("starting_after")).toBe(CHARGE);
  });

  it.each([
    ["a later page fails", [{ data: [], has_more: true }, new Response("boom", { status: 500 })]],
    ["has_more with an empty page", [{ data: [], has_more: true }]],
    ["no has_more at all", [{ data: [] }]],
  ])("reports complete: false when %s", async (_label, bodies) => {
    const [charge] = recorded("stripe.charges.by-customer.json").data;
    const first = (bodies[0] as { data: unknown[] }).data;
    if (bodies.length > 1) first.push(charge);
    serve(...bodies);
    const q = await stripeReader(target()).query(august, CUTOFF, ctx);
    expect(q.complete).toBe(false);
  });

  it("stops at the page cap without claiming completeness", async () => {
    const [charge] = recorded("stripe.charges.by-customer.json").data;
    serve(
      { data: [{ ...charge, id: "ch_a" }], has_more: true },
      { data: [{ ...charge, id: "ch_b" }], has_more: true },
    );
    const q = await stripeReader(target({ maxPages: 2 })).query(august, CUTOFF, ctx);
    expect(q).toMatchObject({ complete: false, matchingIds: ["ch_a", "ch_b"] });
  });

  it("refuses a context for another world or tenant", async () => {
    await expect(
      stripeReader(target()).observe(
        { vendor: "stripe", kind: "charge", id: CHARGE },
        { world: "operational", tenant: "rehearsal-demo" },
      ),
    ).rejects.toThrow(/bound to planning/);
  });
});

describe("zendeskReader", () => {
  it("observes a ticket as its v1 projection, without comments", async () => {
    serve(fixture("zendesk.ticket.json"));
    const obs = await zendeskReader(target()).observe(
      { vendor: "zendesk", kind: "ticket", id: "4000000" },
      ctx,
    );
    expect(obs.projection).toEqual({
      id: "4000000",
      priority: "low",
      status: "open",
      requester_id: "2000051",
    });
  });

  it("follows next_page through every recorded page and checks the count", async () => {
    const { paths } = serve(
      recorded("zendesk.requested.p1.json"),
      recorded("zendesk.requested.p2.json"),
      recorded("zendesk.requested.p3.json"),
    );
    const q = await zendeskReader(target({ pageSize: 2 })).query(byRequester, CUTOFF, ctx);
    expect(q.complete).toBe(true);
    expect(q.matchingIds).toHaveLength(6);
    expect(q.matchingIds).toEqual([...q.matchingIds].sort());
    expect(paths).toEqual([
      "/api/v2/users/2000051/tickets/requested.json?per_page=2",
      "/api/v2/users/2000051/tickets/requested.json?per_page=2&page=2",
      "/api/v2/users/2000051/tickets/requested.json?per_page=2&page=3",
    ]);
  });

  it("is incomplete if a page fails, the count disagrees, or next_page leaves the world", async () => {
    const p1 = recorded("zendesk.requested.p1.json");
    serve(p1, new Response("{}", { status: 503 }));
    expect((await zendeskReader(target()).query(byRequester, CUTOFF, ctx)).complete).toBe(false);

    serve({ ...recorded("zendesk.requested.p3.json"), count: 7 });
    expect((await zendeskReader(target()).query(byRequester, CUTOFF, ctx)).complete).toBe(false);

    const { paths } = serve({ ...p1, next_page: "http://evil.example/api/v2/tickets.json" });
    expect((await zendeskReader(target()).query(byRequester, CUTOFF, ctx)).complete).toBe(false);
    expect(paths).toHaveLength(1);
  });

  it("rejects non-numeric ids before building a path", async () => {
    const reader = zendeskReader(target());
    await expect(
      reader.observe({ vendor: "zendesk", kind: "ticket", id: "1/../../_admin" }, ctx),
    ).rejects.toThrow(/can't observe/);
    await expect(
      reader.query({ kind: "zendesk.tickets.byRequester", requesterId: "1?x" }, CUTOFF, ctx),
    ).rejects.toThrow(/can't query/);
  });
});
