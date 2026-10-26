import { orgTenant } from "@rehearsal/core";
import type { WorldConfig } from "@rehearsal/providers";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app";
import { tenantTokenDepsFromEnv } from "../src/tenant-tokens";

const env = {
  ERA_ADMIN_TOKEN: "admin",
  PLANNER_WORKER_SECRET: "planner-secret",
  EXECUTOR_WORKER_SECRET: "executor-secret",
  ERA_STRIPE_PLANNING_URL: "http://stripe-planning",
  ERA_ZENDESK_PLANNING_URL: "http://zendesk-planning",
  ERA_STRIPE_OPERATIONAL_URL: "http://stripe-operational",
  ERA_ZENDESK_OPERATIONAL_URL: "http://zendesk-operational",
  ERA_TENANT: "rehearsal-demo",
};

function setup() {
  const mint = vi.fn(async (world: WorldConfig, _admin: string) => ({
    token: `jwt-for-${world.baseUrl}`,
    expiresAt: 1,
  }));
  const deps = tenantTokenDepsFromEnv(env);
  if (!deps) throw new Error("minter not configured");
  const app = buildApp({ tenantTokens: { ...deps, mint } });
  const post = (secret: string | undefined, payload: unknown) =>
    app.inject({
      method: "POST",
      url: "/internal/era/tenant-token",
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
      payload: payload as object,
    });
  return { app, mint, post };
}

describe("tenant token minter", () => {
  it("mints planning-world tokens for the planner and operational ones for the executor", async () => {
    const { app, mint, post } = setup();
    expect((await post("planner-secret", { vendor: "stripe" })).json()).toEqual({
      token: "jwt-for-http://stripe-planning",
      expiresAt: 1,
    });
    expect((await post("executor-secret", { vendor: "zendesk" })).json().token).toBe(
      "jwt-for-http://zendesk-operational",
    );
    expect(mint.mock.calls.map(([world, admin]) => [world.tenant, admin])).toEqual([
      ["rehearsal-demo", "admin"],
      ["rehearsal-demo", "admin"],
    ]);
    await app.close();
  });

  it("refuses unknown secrets and bad requests, and never lets a worker pick its world", async () => {
    const { app, mint, post } = setup();
    expect((await post(undefined, { vendor: "stripe" })).statusCode).toBe(401);
    expect((await post("admin", { vendor: "stripe" })).statusCode).toBe(401);
    expect((await post("planner-secret", { vendor: "github" })).statusCode).toBe(400);
    // Slack is optional: without its URL the mint fails closed, and nothing is minted.
    expect((await post("planner-secret", { vendor: "slack" })).statusCode).toBe(502);
    const res = await post("planner-secret", { vendor: "stripe", world: "operational" });
    expect(res.json().token).toBe("jwt-for-http://stripe-planning");
    expect(mint).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("answers 502 when minting fails, so the worker fails closed", async () => {
    const { app, mint, post } = setup();
    mint.mockRejectedValueOnce(new Error("403 access_denied"));
    expect((await post("executor-secret", { vendor: "stripe" })).statusCode).toBe(502);
    await app.close();
  });

  it("is off without the admin token and refuses one secret for both workers", async () => {
    expect(tenantTokenDepsFromEnv({ ...env, ERA_ADMIN_TOKEN: "" })).toBeUndefined();
    expect(() =>
      tenantTokenDepsFromEnv({ ...env, EXECUTOR_WORKER_SECRET: "planner-secret" }),
    ).toThrow(/must differ/);
    for (const name of ["PLANNER_WORKER_SECRET", "EXECUTOR_WORKER_SECRET"]) {
      expect(() => tenantTokenDepsFromEnv({ ...env, [name]: "admin" })).toThrow(
        `${name} must differ from ERA_ADMIN_TOKEN`,
      );
    }
    const app = buildApp();
    const res = await app.inject({ method: "POST", url: "/internal/era/tenant-token" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("tenant token minter, one tenant per org (#330)", () => {
  function orgSetup(working: Record<string, string[]>) {
    const mint = vi.fn(async (world: WorldConfig, _admin: string) => ({
      token: `jwt-for-${world.baseUrl}/${world.tenant}`,
      expiresAt: 1,
    }));
    const deps = tenantTokenDepsFromEnv(env);
    if (!deps) throw new Error("minter not configured");
    const asked: [string, string][] = [];
    const app = buildApp({
      tenantTokens: {
        ...deps,
        mint,
        hasWork: async (role, orgId) => {
          asked.push([role, orgId]);
          return working[role]?.includes(orgId) ?? false;
        },
      },
    });
    const post = (secret: string, payload: object) =>
      app.inject({
        method: "POST",
        url: "/internal/era/tenant-token",
        headers: { authorization: `Bearer ${secret}` },
        payload,
      });
    return { app, mint, post, asked };
  }

  it("mints the org's own tenant in the worker's own world while it has that org's job", async () => {
    const { app, mint, post } = orgSetup({ planner: ["org_a"], executor: ["org_a"] });
    const planner = await post("planner-secret", { vendor: "stripe", orgId: "org_a" });
    expect(planner.json().token).toBe(`jwt-for-http://stripe-planning/${orgTenant("org_a")}`);
    const executor = await post("executor-secret", { vendor: "zendesk", orgId: "org_a" });
    expect(executor.json().token).toBe(`jwt-for-http://zendesk-operational/${orgTenant("org_a")}`);
    // Naming a world changes nothing: the role picks it.
    const sneaky = await post("planner-secret", {
      vendor: "stripe",
      orgId: "org_a",
      world: "operational",
    });
    expect(sneaky.json().token).toBe(`jwt-for-http://stripe-planning/${orgTenant("org_a")}`);
    expect(mint).toHaveBeenCalledTimes(3);
    await app.close();
  });

  it("refuses another org's tenant to a worker that has no job for it", async () => {
    const { app, mint, post, asked } = orgSetup({ planner: ["org_a"], executor: [] });
    const other = await post("planner-secret", { vendor: "stripe", orgId: "org_b" });
    expect(other.statusCode).toBe(403);
    expect(other.json()).toEqual({ error: "no_work_for_org" });
    // The planner's work for org A gives the executor nothing in org A.
    expect((await post("executor-secret", { vendor: "stripe", orgId: "org_a" })).statusCode).toBe(
      403,
    );
    expect(asked).toEqual([
      ["planner", "org_b"],
      ["executor", "org_a"],
    ]);
    expect(mint).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses every org mint when the API can't check for work", async () => {
    const deps = tenantTokenDepsFromEnv(env);
    if (!deps) throw new Error("minter not configured");
    const mint = vi.fn();
    const app = buildApp({ tenantTokens: { ...deps, mint } });
    const res = await app.inject({
      method: "POST",
      url: "/internal/era/tenant-token",
      headers: { authorization: "Bearer executor-secret" },
      payload: { vendor: "stripe", orgId: "org_a" },
    });
    expect(res.statusCode).toBe(403);
    expect(mint).not.toHaveBeenCalled();
    await app.close();
  });
});
