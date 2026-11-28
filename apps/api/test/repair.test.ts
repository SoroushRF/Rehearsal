import { orgTenant } from "@rehearsal/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eraPlanningRefresher } from "../src/repair";

const ENV = {
  ERA_ADMIN_TOKEN: "admin",
  ERA_STRIPE_PLANNING_URL: "http://planning-stripe",
  ERA_STRIPE_OPERATIONAL_URL: "http://operational-stripe",
  ERA_ZENDESK_PLANNING_URL: "http://planning-zendesk",
  ERA_ZENDESK_OPERATIONAL_URL: "http://operational-zendesk",
};
const PHANTOM = { id: "ch_phantom", object: "charge", amount: 4210, currency: "cad" };

afterEach(() => vi.unstubAllGlobals());

/** A fake Era: one token endpoint per container, and charges by world. */
function era(planning: Record<string, unknown>, operational: Record<string, unknown>) {
  const calls: { url: string; method: string; body?: unknown; tenant?: string | null }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    calls.push({
      url,
      method: init.method ?? "GET",
      ...(typeof init.body === "string" && { body: JSON.parse(init.body) }),
      tenant: headers.get("X-Sim-Tenant"),
    });
    if (url.endsWith("/token")) {
      return Response.json({ access_token: `tok@${new URL(url).host}`, expires_in: 3600 });
    }
    if (url.includes("/_admin/")) return new Response(null, { status: 204 });
    const world = url.includes("planning") ? planning : operational;
    const id = decodeURIComponent(url.split("/").at(-1) ?? "");
    return id in world ? Response.json(world[id]) : new Response("{}", { status: 404 });
  });
  return calls;
}

describe("refreshing the planning copy for a repair (T1.37)", () => {
  const refresh = eraPlanningRefresher(ENV);
  if (!refresh) throw new Error("no refresher");
  const charge = [{ vendor: "stripe" as const, kind: "charge" as const, id: "ch_phantom" }];

  it("copies a record the hold found from operational into the org's planning tenant", async () => {
    const calls = era({}, { ch_phantom: PHANTOM });
    expect(await refresh("org_a", charge)).toEqual(["ch_phantom"]);
    const inject = calls.find((c) => c.url.includes("/_admin/"));
    expect(inject).toMatchObject({
      url: `http://planning-stripe/_admin/tenants/${orgTenant("org_a")}/inject`,
      method: "POST",
      body: { charges: [PHANTOM] },
    });
    // Reads go through tokens minted by each container for the org's tenant.
    expect(
      calls.filter((c) => c.url.includes("/v1/charges/")).map((c) => [c.url, c.tenant]),
    ).toEqual([
      ["http://planning-stripe/v1/charges/ch_phantom", "tok@planning-stripe"],
      ["http://operational-stripe/v1/charges/ch_phantom", "tok@operational-stripe"],
    ]);
  });

  it("injects nothing the planning world already has: Era's inject doesn't dedupe", async () => {
    const calls = era({ ch_phantom: PHANTOM }, { ch_phantom: PHANTOM });
    expect(await refresh("org_a", charge)).toEqual([]);
    expect(calls.some((c) => c.url.includes("/_admin/"))).toBe(false);
  });

  it("fails rather than guess when the operational record can't be read", async () => {
    const calls = era({}, {});
    await expect(refresh("org_a", charge)).rejects.toThrow(/operational GET .* 404/);
    expect(calls.some((c) => c.url.includes("/_admin/"))).toBe(false);
  });

  it("copies a Zendesk ticket from inside its GET envelope", async () => {
    const ticket = { id: 9100001, priority: "normal" };
    const calls = era({}, { "9100001.json": { ticket } });
    await refresh("org_a", [{ vendor: "zendesk", kind: "ticket", id: "9100001" }]);
    expect(calls.find((c) => c.url.includes("/_admin/"))?.body).toEqual({ tickets: [ticket] });
  });

  it("is absent without the admin token", () => {
    expect(eraPlanningRefresher({ ...ENV, ERA_ADMIN_TOKEN: undefined })).toBeUndefined();
  });
});
