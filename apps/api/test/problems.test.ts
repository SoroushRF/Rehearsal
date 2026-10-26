import { orgTenant } from "@rehearsal/core";
import { type ProblemRecords, problemRecords } from "@rehearsal/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app";
import { eraProblemInjector } from "../src/problems";
import { bearer, type Caller, fakeIam, member, support } from "./fake-iam";

describe("POST /api/company/problems", () => {
  const injected: [string, ProblemRecords][] = [];
  const app = (
    me: Caller | null,
    inject = async (orgId: string, r: ProblemRecords) => {
      injected.push([orgId, r]);
    },
  ) => buildApp({ webRoot: null, problems: { iam: fakeIam(me ? [me] : []), inject } });
  const create = (me: Caller | null, payload: unknown, a = app(me)) =>
    a.inject({
      method: "POST",
      url: "/api/company/problems",
      headers: me ? bearer(me) : {},
      payload: payload as object,
    });

  it("lets only a person who may rehearse create a problem", async () => {
    const preset = { preset: "duplicate_charge", count: 1 };
    expect((await create(null, preset)).statusCode).toBe(401);
    expect((await create(member("org_1"), preset)).statusCode).toBe(403);
  });

  it("takes a preset and a count, never records", async () => {
    const me = support("org_1", "user_1");
    const before = injected.length;
    expect((await create(me, { preset: "duplicate_charge", count: 9 })).statusCode).toBe(400);
    expect(
      (await create(me, { preset: "duplicate_charge", count: 1, charges: [{}] })).statusCode,
    ).toBe(204);
    expect((await create(me, { preset: "service_outage", count: 1 })).json()).toEqual({
      error: "unsupported_preset",
    });
    // The extra field was ignored: the records are the preset's alone.
    expect(injected.length).toBe(before + 1);
    expect(injected.at(-1)?.[1].stripe.charges).toHaveLength(2);
  });

  it("injects the preset's records for the caller's org", async () => {
    const me = support("org_2", "user_1");
    expect((await create(me, { preset: "support_backlog", count: 3 })).statusCode).toBe(204);
    const [orgId, records] = injected.at(-1) ?? [];
    expect(orgId).toBe("org_2");
    expect(records?.stripe.charges).toEqual([]);
    expect(records?.zendesk.tickets.map((t) => t.status)).toEqual(["new", "new", "new"]);
  });

  it("seeds the org's worlds before injecting, so seeding can't wipe the problem", async () => {
    const me = support("org_3", "user_1");
    const order: string[] = [];
    const seeded = buildApp({
      webRoot: null,
      problems: {
        iam: fakeIam([me]),
        ensureSeeded: async (orgId) => {
          order.push(`seed ${orgId}`);
        },
        inject: async (orgId) => {
          order.push(`inject ${orgId}`);
        },
      },
    });
    expect((await create(me, { preset: "duplicate_charge", count: 1 }, seeded)).statusCode).toBe(
      204,
    );
    expect(order).toEqual(["seed org_3", "inject org_3"]);
    const broken = buildApp({
      webRoot: null,
      problems: {
        iam: fakeIam([me]),
        ensureSeeded: async () => {
          throw new Error("era down");
        },
        inject: async () => {
          order.push("inject anyway");
        },
      },
    });
    expect((await create(me, { preset: "duplicate_charge", count: 1 }, broken)).json()).toEqual({
      error: "world_unavailable",
    });
    expect(order).not.toContain("inject anyway");
  });

  it("answers inject_failed when Era refuses, and 404 when this API can't inject", async () => {
    const me = support("org_1", "user_1");
    const down = app(me, async () => {
      throw new Error("era down");
    });
    expect((await create(me, { preset: "duplicate_charge", count: 1 }, down)).json()).toEqual({
      error: "inject_failed",
    });
    const res = await buildApp({ webRoot: null }).inject({
      method: "POST",
      url: "/api/company/problems",
      payload: { preset: "duplicate_charge", count: 1 },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("eraProblemInjector", () => {
  afterEach(() => vi.unstubAllGlobals());
  const env = {
    ERA_ADMIN_TOKEN: "admin",
    ERA_STRIPE_PLANNING_URL: "http://stripe-planning.test",
    ERA_STRIPE_OPERATIONAL_URL: "http://stripe-operational.test",
    ERA_ZENDESK_PLANNING_URL: "http://zendesk-planning.test",
    ERA_ZENDESK_OPERATIONAL_URL: "http://zendesk-operational.test",
  };

  it("is off without the admin token", () => {
    expect(eraProblemInjector({})).toBeUndefined();
  });

  it("writes the same records into both of the org's own worlds, only for vendors with any", async () => {
    const calls: [string, unknown][] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push([url, JSON.parse(String(init.body))]);
      return new Response(null, { status: 200 });
    });
    const records = problemRecords("duplicate_charge", 1, "x1", 9_300_000) as ProblemRecords;
    await eraProblemInjector(env)?.("org_1", records);
    expect(calls).toEqual([
      [`http://stripe-planning.test/_admin/tenants/${orgTenant("org_1")}/inject`, records.stripe],
      [
        `http://stripe-operational.test/_admin/tenants/${orgTenant("org_1")}/inject`,
        records.stripe,
      ],
    ]);
  });

  it("stops at the first refused write", async () => {
    vi.stubGlobal("fetch", async () => new Response("no", { status: 500 }));
    const records = problemRecords("support_backlog", 1, "x2", 9_300_000) as ProblemRecords;
    await expect(eraProblemInjector(env)?.("org_1", records)).rejects.toThrow(
      "zendesk planning inject → 500",
    );
  });
});
