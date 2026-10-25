import { FakeClock } from "@rehearsal/testkit";
import { describe, expect, it, vi } from "vitest";
import {
  REHEARSAL_TENANT_TOKEN_ROUTE,
  rehearsalWorkerViolations,
  rehearsalWorkerWorlds,
  resolveRehearsalWorld,
} from "../src";

const HOUR = 3_600_000;
const ID = "abcd1234";

// The rehearsal worker's own environment: no shared URLs, admin tokens, model keys or secrets.
const env = {
  REHEARSAL_API_URL: "http://api/",
  REHEARSAL_WORKER_SECRET: "rehearsal-secret",
  ERA_STRIPE_REHEARSAL_URL: "http://127.0.0.1:8103",
  ERA_ZENDESK_REHEARSAL_URL: "http://127.0.0.1:8113/",
};

/** The operator's answer: a token for `tenant` in the container at `baseUrl`. */
function operator(clock: FakeClock, answer: (vendor: string) => object = () => ({})) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const { vendor } = JSON.parse(String(init?.body)) as { vendor: "stripe" | "zendesk" };
    const baseUrl =
      env[vendor === "stripe" ? "ERA_STRIPE_REHEARSAL_URL" : "ERA_ZENDESK_REHEARSAL_URL"];
    return Response.json({
      token: `jwt-${vendor}`,
      expiresAt: clock.now().getTime() + HOUR,
      tenant: `rh-${ID}`,
      baseUrl,
      ...answer(vendor),
    });
  });
}

const token = (world: { tenantToken?: unknown }) =>
  (world.tenantToken as { get(): Promise<string> }).get();

describe("rehearsal worker worlds (T1.23)", () => {
  it("binds one rehearsal's rh- tenant and mints it with the rehearsal secret", async () => {
    const clock = new FakeClock();
    const fetch = operator(clock);
    const worlds = rehearsalWorkerWorlds(ID, env, { fetch, clock });
    expect([worlds.stripe.baseUrl, worlds.stripe.tenant]).toEqual([
      "http://127.0.0.1:8103",
      `rh-${ID}`,
    ]);
    expect(worlds.zendesk.baseUrl).toBe("http://127.0.0.1:8113");
    expect(await token(worlds.stripe)).toBe("jwt-stripe");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://api${REHEARSAL_TENANT_TOKEN_ROUTE}`);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer rehearsal-secret");
    expect(JSON.parse(init.body as string)).toEqual({ vendor: "stripe", rehearsalId: ID });
  });

  it("fails closed on a token for another tenant or another container", async () => {
    const clock = new FakeClock();
    const foreign = rehearsalWorkerWorlds(ID, env, {
      clock,
      fetch: operator(clock, () => ({ tenant: "rh-other0001" })),
    });
    await expect(token(foreign.stripe)).rejects.toThrow(`minted for rh-other0001, not rh-${ID}`);
    // The worker was pointed at the operational container; the operator minted for 8103.
    const misrouted = rehearsalWorkerWorlds(
      ID,
      { ...env, ERA_STRIPE_REHEARSAL_URL: "http://localhost:8102" },
      { clock, fetch: operator(clock) },
    );
    await expect(token(misrouted.stripe)).rejects.toThrow(
      "minted for http://127.0.0.1:8103, but configured for http://localhost:8102",
    );
    // Same endpoint, another world behind a path prefix or another scheme: still refused.
    const base = "http://127.0.0.1:8103";
    for (const [configured, minted] of [
      [`${base}/operational`, `${base}/rehearsal`],
      [base, `${base}/rehearsal`],
      ["https://127.0.0.1:8103", base],
    ]) {
      const prefixed = rehearsalWorkerWorlds(
        ID,
        { ...env, ERA_STRIPE_REHEARSAL_URL: configured },
        { clock, fetch: operator(clock, () => ({ baseUrl: minted })) },
      );
      await expect(token(prefixed.stripe)).rejects.toThrow(
        `minted for ${minted}, but configured for ${configured}`,
      );
    }
    // Loopback spellings and a trailing slash are the same world.
    const folded = rehearsalWorkerWorlds(
      ID,
      { ...env, ERA_STRIPE_REHEARSAL_URL: "http://localhost:8103/rehearsal/" },
      { clock, fetch: operator(clock, () => ({ baseUrl: `${base}/rehearsal` })) },
    );
    expect(await token(folded.stripe)).toBe("jwt-stripe");
    const unparsed = rehearsalWorkerWorlds(ID, env, {
      clock,
      fetch: operator(clock, () => ({ baseUrl: undefined })),
    });
    await expect(token(unparsed.zendesk)).rejects.toThrow(/no valid Era tenant token/);
  });

  it("refreshes before expiry, and fails closed once a refused refresh outlives the token", async () => {
    const clock = new FakeClock();
    let refused = false;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
      refused ? new Response("{}", { status: 409 }) : operator(clock)(url, init),
    );
    const worlds = rehearsalWorkerWorlds(ID, env, { fetch, clock });
    expect(await token(worlds.stripe)).toBe("jwt-stripe");
    // Torn down: the operator stops minting for it. The old token lasts until it expires.
    refused = true;
    clock.advance(HOUR - 60_000);
    expect(await token(worlds.stripe)).toBe("jwt-stripe");
    clock.advance(60_000);
    await expect(token(worlds.stripe)).rejects.toThrow(/→ 409/);
  });

  it("refuses to start next to any other authority", () => {
    for (const key of [
      "ANTHROPIC_API_KEY",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "ERA_ADMIN_TOKEN",
      "REHEARSAL_ERA_ADMIN_TOKEN",
      "PLANNER_WORKER_SECRET",
      "EXECUTOR_WORKER_SECRET",
      "ERA_STRIPE_PLANNING_URL",
      "ERA_ZENDESK_OPERATIONAL_URL",
      "ERA_SLACK_OPERATIONAL_URL",
    ]) {
      expect(rehearsalWorkerViolations({ ...env, [key]: "x" })).toEqual([key]);
      expect(() => rehearsalWorkerWorlds(ID, { ...env, [key]: "x" })).toThrow(key);
    }
    expect(rehearsalWorkerViolations(env)).toEqual([]);
    expect(() => rehearsalWorkerWorlds(ID, { ...env, REHEARSAL_WORKER_SECRET: "" })).toThrow(
      /REHEARSAL_WORKER_SECRET/,
    );
    expect(() => rehearsalWorkerWorlds("Not An Id", env)).toThrow();
  });
});

describe("resolveRehearsalWorld", () => {
  it("refuses a rehearsal URL that a shared world in the same environment uses", () => {
    const operatorEnv = {
      ...env,
      ERA_STRIPE_PLANNING_URL: "http://127.0.0.1:8101",
      ERA_STRIPE_OPERATIONAL_URL: "http://127.0.0.1:8102",
    };
    expect(resolveRehearsalWorld("stripe", ID, operatorEnv).tenant).toBe(`rh-${ID}`);
    for (const url of [
      "http://localhost:8102/",
      "http://[::1]:8101",
      "http://127.0.0.1:8102",
      "http://127.0.0.1:8102/rehearsal",
    ]) {
      expect(() =>
        resolveRehearsalWorld("stripe", ID, { ...operatorEnv, ERA_STRIPE_REHEARSAL_URL: url }),
      ).toThrow("a rehearsal never runs in a shared world");
    }
    for (const url of [
      "http://user:pw@127.0.0.1:8103",
      "http://127.0.0.1:8103?world=rehearsal",
      "ftp://127.0.0.1:8103",
    ]) {
      expect(() =>
        resolveRehearsalWorld("stripe", ID, { ...operatorEnv, ERA_STRIPE_REHEARSAL_URL: url }),
      ).toThrow("a world URL is http(s) with no credentials, query or fragment");
    }
    expect(() => resolveRehearsalWorld("slack", ID, operatorEnv)).toThrow(
      /ERA_SLACK_REHEARSAL_URL is not set/,
    );
  });
});
