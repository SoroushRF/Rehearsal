import type { WorldConfig } from "@rehearsal/providers";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app";
import { rehearsalTokenDepsFromEnv } from "../src/rehearsal-tokens";
import { tenantTokenDepsFromEnv } from "../src/tenant-tokens";

const env = {
  ERA_ADMIN_TOKEN: "admin",
  REHEARSAL_ERA_ADMIN_TOKEN: "rehearsal-admin",
  PLANNER_WORKER_SECRET: "planner-secret",
  EXECUTOR_WORKER_SECRET: "executor-secret",
  REHEARSAL_WORKER_SECRET: "rehearsal-secret",
  ERA_STRIPE_PLANNING_URL: "http://127.0.0.1:8101",
  ERA_STRIPE_OPERATIONAL_URL: "http://127.0.0.1:8102",
  ERA_ZENDESK_PLANNING_URL: "http://127.0.0.1:8111",
  ERA_ZENDESK_OPERATIONAL_URL: "http://127.0.0.1:8112",
  ERA_STRIPE_REHEARSAL_URL: "http://127.0.0.1:8103",
  ERA_ZENDESK_REHEARSAL_URL: "http://127.0.0.1:8113",
};
const ACTIVE = "abcd1234";

function setup(overrides: Record<string, string> = {}) {
  const mint = vi.fn(async (world: WorldConfig, _admin: string) => ({
    token: `jwt-for-${world.tenant}@${world.baseUrl}`,
    expiresAt: 1,
  }));
  const active = new Set([ACTIVE]);
  const deps = rehearsalTokenDepsFromEnv((id) => active.has(id), { ...env, ...overrides });
  const workers = tenantTokenDepsFromEnv(env);
  if (!deps || !workers) throw new Error("minter not configured");
  const app = buildApp({
    rehearsalTokens: { ...deps, mint },
    tenantTokens: { ...workers, mint },
  });
  const post = (url: string, secret: string | undefined, payload: unknown) =>
    app.inject({
      method: "POST",
      url,
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
      payload: payload as object,
    });
  const rehearsal = (secret: string | undefined, payload: unknown) =>
    post("/internal/era/rehearsal-tenant-token", secret, payload);
  return { app, mint, active, post, rehearsal };
}

describe("rehearsal token minter (T1.23)", () => {
  it("mints a provisioned rehearsal's rh- tenant in the rehearsal container, with its own admin token", async () => {
    const { app, mint, rehearsal } = setup();
    const res = await rehearsal("rehearsal-secret", { vendor: "stripe", rehearsalId: ACTIVE });
    expect(res.json()).toEqual({
      token: `jwt-for-rh-${ACTIVE}@http://127.0.0.1:8103`,
      expiresAt: 1,
      tenant: `rh-${ACTIVE}`,
      baseUrl: "http://127.0.0.1:8103",
    });
    expect(mint.mock.calls.map(([, admin]) => admin)).toEqual(["rehearsal-admin"]);
    await app.close();
  });

  it("refuses other workers' secrets, and the rehearsal secret on the workers' route", async () => {
    const { app, mint, post, rehearsal } = setup();
    for (const secret of [
      undefined,
      "planner-secret",
      "executor-secret",
      "admin",
      "rehearsal-admin",
    ]) {
      expect((await rehearsal(secret, { vendor: "stripe", rehearsalId: ACTIVE })).statusCode).toBe(
        401,
      );
    }
    const res = await post("/internal/era/tenant-token", "rehearsal-secret", { vendor: "stripe" });
    expect(res.statusCode).toBe(401);
    expect(mint).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses a rehearsal that isn't provisioned, or no longer is", async () => {
    const { app, active, mint, rehearsal } = setup();
    const ask = () => rehearsal("rehearsal-secret", { vendor: "zendesk", rehearsalId: ACTIVE });
    expect((await ask()).statusCode).toBe(200);
    active.delete(ACTIVE);
    expect((await ask()).json()).toEqual({ error: "rehearsal_not_provisioned" });
    const other = await rehearsal("rehearsal-secret", {
      vendor: "zendesk",
      rehearsalId: "other0001",
    });
    expect(other.statusCode).toBe(409);
    expect(mint).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("hands out no token when teardown lands while the mint is in flight", async () => {
    const { app, active, mint, rehearsal } = setup();
    let release = () => {};
    const paused = new Promise<void>((r) => {
      release = r;
    });
    mint.mockImplementationOnce(async (world) => {
      await paused;
      return { token: `jwt-for-${world.tenant}`, expiresAt: 1 };
    });
    const pending = rehearsal("rehearsal-secret", { vendor: "stripe", rehearsalId: ACTIVE });
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1));
    active.delete(ACTIVE);
    release();
    const res = await pending;
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "rehearsal_not_provisioned" });
    expect(res.body).not.toContain("jwt-for-");
    await app.close();
  });

  it("never lets the worker pick a tenant, URL, world or vendor outside the list", async () => {
    const { app, mint, rehearsal } = setup();
    for (const payload of [
      { vendor: "stripe", rehearsalId: ACTIVE, tenant: "rehearsal-demo" },
      { vendor: "stripe", rehearsalId: ACTIVE, baseUrl: "http://127.0.0.1:8102" },
      { vendor: "stripe", rehearsalId: ACTIVE, world: "operational" },
      { vendor: "slack", rehearsalId: ACTIVE },
      { vendor: "stripe", rehearsalId: "rh-abcd1234" },
      { vendor: "stripe" },
    ]) {
      expect((await rehearsal("rehearsal-secret", payload)).statusCode).toBe(400);
    }
    expect(mint).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses to mint when the rehearsal URL is a shared world's", async () => {
    const { app, mint, rehearsal } = setup({ ERA_STRIPE_REHEARSAL_URL: "http://localhost:8102" });
    const res = await rehearsal("rehearsal-secret", { vendor: "stripe", rehearsalId: ACTIVE });
    expect([res.statusCode, res.json()]).toEqual([503, { error: "rehearsal_world_unavailable" }]);
    expect(mint).not.toHaveBeenCalled();
    await app.close();
  });

  it("isn't configured without its own admin token and secret, or with shared ones", () => {
    const active = () => true;
    expect(rehearsalTokenDepsFromEnv(active, { ...env, REHEARSAL_WORKER_SECRET: "" })).toBe(
      undefined,
    );
    expect(() =>
      rehearsalTokenDepsFromEnv(active, { ...env, REHEARSAL_ERA_ADMIN_TOKEN: "admin" }),
    ).toThrow("must differ from ERA_ADMIN_TOKEN");
    for (const shared of ["planner-secret", "executor-secret"]) {
      expect(() =>
        rehearsalTokenDepsFromEnv(active, { ...env, REHEARSAL_WORKER_SECRET: shared }),
      ).toThrow("REHEARSAL_WORKER_SECRET must differ");
    }
    // An admin token under the worker's allowed name would pass the worker's own startup check.
    for (const [admin, name] of [
      ["admin", "ERA_ADMIN_TOKEN"],
      ["rehearsal-admin", "REHEARSAL_ERA_ADMIN_TOKEN"],
    ]) {
      expect(() =>
        rehearsalTokenDepsFromEnv(active, { ...env, REHEARSAL_WORKER_SECRET: admin }),
      ).toThrow(`REHEARSAL_WORKER_SECRET must differ from ${name}`);
    }
    for (const [secret, name] of [
      ["planner-secret", "PLANNER_WORKER_SECRET"],
      ["executor-secret", "EXECUTOR_WORKER_SECRET"],
    ]) {
      expect(() =>
        rehearsalTokenDepsFromEnv(active, { ...env, REHEARSAL_ERA_ADMIN_TOKEN: secret }),
      ).toThrow(`REHEARSAL_ERA_ADMIN_TOKEN must differ from ${name}`);
    }
  });
});
