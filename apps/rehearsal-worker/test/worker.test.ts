import type { Db } from "@rehearsal/db";
import { FakeClock, FIXTURE_REHEARSAL_VERSIONS } from "@rehearsal/testkit";
import { describe, expect, it, vi } from "vitest";
import { type RehearsalWorkerConfig, runContext, sweepTimings } from "../src/worker";

describe("sweep timings", () => {
  it("defaults to a 1 min sweep, a 15 min lease and a 1 h hand-off", () => {
    expect(sweepTimings({})).toEqual({
      SWEEP_EVERY_MS: 60_000,
      LEASE_MS: 900_000,
      HAND_OFF_AFTER_MS: 3_600_000,
    });
  });

  it("takes whole positive milliseconds from the env and ignores anything else", () => {
    expect(
      sweepTimings({
        REHEARSAL_SWEEP_EVERY_MS: "5000",
        REHEARSAL_LEASE_MS: "-1",
        REHEARSAL_HAND_OFF_AFTER_MS: "1.5",
      }),
    ).toEqual({ SWEEP_EVERY_MS: 5000, LEASE_MS: 900_000, HAND_OFF_AFTER_MS: 3_600_000 });
    expect(sweepTimings({ REHEARSAL_LEASE_MS: "soon" }).LEASE_MS).toBe(900_000);
  });
});

describe("world check (#323)", () => {
  const ID = "abcd1234abcd1234";
  const env = {
    REHEARSAL_API_URL: "http://api",
    REHEARSAL_WORKER_SECRET: "rehearsal-secret",
    DATABASE_URL: "postgres://unused",
    ERA_STRIPE_REHEARSAL_URL: "http://127.0.0.1:8103",
    ERA_ZENDESK_REHEARSAL_URL: "http://127.0.0.1:8113",
  };
  /** The operator mints for the rehearsal containers it knows: 8103 and 8113. */
  function config(over: Partial<NodeJS.ProcessEnv> = {}) {
    const clock = new FakeClock();
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const { vendor } = JSON.parse(String(init?.body)) as { vendor: string };
      return Response.json({
        token: `jwt-${vendor}`,
        expiresAt: clock.now().getTime() + 3_600_000,
        tenant: `rh-${ID}`,
        baseUrl: vendor === "stripe" ? "http://127.0.0.1:8103" : "http://127.0.0.1:8113",
      });
    });
    const c: RehearsalWorkerConfig = {
      db: {} as Db,
      env: { ...env, ...over },
      clock,
      policies: [],
      newId: (p) => `${p}_1`,
      versions: FIXTURE_REHEARSAL_VERSIONS,
      evidence: "fixture",
      fetch: fetch as unknown as typeof globalThis.fetch,
    };
    return { c, fetch };
  }

  it("passes when both tokens are minted for the containers this worker calls", async () => {
    const { c, fetch } = config();
    await expect(runContext(ID, c).checkWorlds?.(ID)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refuses a worker pointed at the operational or planning containers, naming both URLs", async () => {
    for (const url of ["http://127.0.0.1:8102", "http://127.0.0.1:8101"]) {
      const { c } = config({ ERA_STRIPE_REHEARSAL_URL: url });
      await expect(runContext(ID, c).checkWorlds?.(ID)).rejects.toThrow(
        `minted for http://127.0.0.1:8103, but configured for ${url}`,
      );
    }
    const { c } = config({ ERA_ZENDESK_REHEARSAL_URL: "http://127.0.0.1:8112" });
    await expect(runContext(ID, c).checkWorlds?.(ID)).rejects.toThrow(
      "minted for http://127.0.0.1:8113, but configured for http://127.0.0.1:8112",
    );
  });
});
