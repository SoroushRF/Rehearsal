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
    expect((await post("planner-secret", { vendor: "slack" })).statusCode).toBe(400);
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
