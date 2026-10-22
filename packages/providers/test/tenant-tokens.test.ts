import { FakeClock } from "@rehearsal/testkit";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REFRESH_MARGIN_MS,
  eraFetch,
  type MintedToken,
  RefreshingTokenSource,
  TENANT_TOKEN_ROUTE,
  workerWorlds,
} from "../src";

const HOUR = 3_600_000;

/** Mints "t1", "t2", … valid for one hour from the fake clock's now. */
function minter(clock: FakeClock) {
  let n = 0;
  return vi.fn(
    async (): Promise<MintedToken> => ({
      token: `t${++n}`,
      expiresAt: clock.now().getTime() + HOUR,
    }),
  );
}

describe("RefreshingTokenSource", () => {
  it("reuses a token until the refresh margin, then mints a new one", async () => {
    const clock = new FakeClock();
    const mint = minter(clock);
    const source = new RefreshingTokenSource(mint, clock);

    expect(await source.get()).toBe("t1");
    clock.advance(HOUR - DEFAULT_REFRESH_MARGIN_MS - 1);
    expect(await source.get()).toBe("t1");
    expect(mint).toHaveBeenCalledTimes(1);

    clock.advance(1);
    expect(await source.get()).toBe("t2");
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it("mints once for concurrent callers", async () => {
    const clock = new FakeClock();
    const mint = minter(clock);
    const source = new RefreshingTokenSource(mint, clock);
    expect(await Promise.all([source.get(), source.get(), source.get()])).toEqual([
      "t1",
      "t1",
      "t1",
    ]);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("keeps a still-valid token through a failed refresh, then fails closed at expiry", async () => {
    const clock = new FakeClock();
    const mint = minter(clock);
    const source = new RefreshingTokenSource(mint, clock);
    await source.get();

    mint.mockRejectedValue(new Error("minter down"));
    clock.advance(HOUR - 1000);
    expect(await source.get()).toBe("t1");

    clock.advance(1000);
    await expect(source.get()).rejects.toThrow(/no valid Era tenant token: minter down/);
  });

  it("fails closed when the first mint fails or returns an expired or malformed token", async () => {
    const clock = new FakeClock();
    await expect(
      new RefreshingTokenSource(() => Promise.reject(new Error("403")), clock).get(),
    ).rejects.toThrow(/no valid Era tenant token/);
    await expect(
      new RefreshingTokenSource(async () => ({ token: "x", expiresAt: 0 }), clock).get(),
    ).rejects.toThrow(/expired/);
    await expect(
      new RefreshingTokenSource(async () => ({ token: "", expiresAt: Date.now() }) as never).get(),
    ).rejects.toThrow(/no valid Era tenant token/);
  });
});

describe("eraFetch with a token source", () => {
  it("sends the signed token, and sends nothing when no token can be had", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    try {
      const clock = new FakeClock();
      const world = {
        baseUrl: "http://era",
        tenant: "rehearsal-demo",
        tenantToken: new RefreshingTokenSource(minter(clock), clock),
      };
      await eraFetch(world, "/v1/charges");
      expect(new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get("x-sim-tenant")).toBe("t1");

      const broken = {
        ...world,
        tenantToken: new RefreshingTokenSource(() => Promise.reject(new Error("down")), clock),
      };
      await expect(eraFetch(broken, "/v1/charges")).rejects.toThrow(/no valid Era tenant token/);
      // No request went out under the plaintext tenant name (which Era would serve as "default").
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("workerWorlds", () => {
  const env = {
    REHEARSAL_API_URL: "http://api/",
    PLANNER_WORKER_SECRET: "planner-secret",
    EXECUTOR_WORKER_SECRET: "executor-secret",
    ERA_STRIPE_PLANNING_URL: "http://stripe-planning",
    ERA_ZENDESK_PLANNING_URL: "http://zendesk-planning",
    ERA_STRIPE_OPERATIONAL_URL: "http://stripe-operational",
    ERA_ZENDESK_OPERATIONAL_URL: "http://zendesk-operational",
  };

  it.each([
    ["planner", "planning", "planner-secret"],
    ["executor", "operational", "executor-secret"],
  ] as const)(
    "binds the %s to %s worlds and mints with its own secret",
    async (role, world, secret) => {
      const fetch = vi.fn(async () =>
        Response.json({ token: "jwt", expiresAt: Date.now() + HOUR }),
      );
      const worlds = workerWorlds(role, env, { fetch });
      expect(worlds.stripe.baseUrl).toBe(`http://stripe-${world}`);
      expect(worlds.zendesk.baseUrl).toBe(`http://zendesk-${world}`);

      expect(
        typeof worlds.zendesk.tenantToken === "object" && (await worlds.zendesk.tenantToken.get()),
      ).toBe("jwt");
      const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(`http://api${TENANT_TOKEN_ROUTE}`);
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${secret}`);
      expect(JSON.parse(init.body as string)).toEqual({ vendor: "zendesk" });
    },
  );

  it("refuses to bind without the minter URL or the worker's secret", () => {
    expect(() => workerWorlds("planner", { ...env, REHEARSAL_API_URL: "" })).toThrow(
      /REHEARSAL_API_URL/,
    );
    expect(() => workerWorlds("executor", { ...env, EXECUTOR_WORKER_SECRET: "" })).toThrow(
      /EXECUTOR_WORKER_SECRET/,
    );
  });
});
