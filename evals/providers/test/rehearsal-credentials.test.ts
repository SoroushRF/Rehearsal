import { randomBytes } from "node:crypto";
import {
  eraAdmin,
  eraFetch,
  mintTenantToken,
  type RehearsalMintedToken,
  rehearsalWorkerWorlds,
  resolveRehearsalWorld,
  resolveWorld,
  type WorldConfig,
} from "@rehearsal/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rehearsalAdminToken, teardownSnapshot } from "../../../scripts/seed/snapshot";
import { REHEARSAL_ENABLED } from "../src/harness";

const id = () => `t123${randomBytes(4).toString("hex")}`;
const CHARGE = "ch_T123isolation";

/**
 * T1.23 on Era: the rehearsal worker's tokens, minted as the operator's route mints them (with the
 * rehearsal admin token, for `rh-<id>` in the rehearsal containers only), reach their own tenant
 * and no other. The worker's environment holds no shared URL, admin token or other secret.
 */
describe.skipIf(!REHEARSAL_ENABLED)("rehearsal worker credentials on Era", () => {
  const [a, b] = [id(), id()];
  const operatorEnv = process.env;
  const workerEnv = {
    REHEARSAL_API_URL: "http://operator",
    REHEARSAL_WORKER_SECRET: "rehearsal-secret",
    ERA_STRIPE_REHEARSAL_URL: process.env.ERA_STRIPE_REHEARSAL_URL,
    ERA_ZENDESK_REHEARSAL_URL: process.env.ERA_ZENDESK_REHEARSAL_URL,
  };
  // Stands in for the API's route: the same world resolution and mint, with the real admin token.
  const operator: typeof fetch = async (_url, init) => {
    const { vendor, rehearsalId } = JSON.parse(String(init?.body));
    const world = resolveRehearsalWorld(vendor, rehearsalId, operatorEnv);
    const minted = await mintTenantToken(world, rehearsalAdminToken());
    const body: RehearsalMintedToken = { ...minted, tenant: world.tenant, baseUrl: world.baseUrl };
    return Response.json(body);
  };
  const read = (world: WorldConfig, path: string) =>
    eraFetch(world, path, { headers: { authorization: "Bearer sk_test_t123" } });

  beforeAll(async () => {
    const world = resolveRehearsalWorld("stripe", a, operatorEnv);
    const res = await eraAdmin(world, rehearsalAdminToken(), "/inject", {
      charges: [
        {
          id: CHARGE,
          object: "charge",
          amount: 100,
          amount_captured: 100,
          amount_refunded: 0,
          currency: "cad",
          customer: "cus_T123",
          status: "succeeded",
          created: 1_790_000_000,
          refunds: {
            object: "list",
            data: [],
            has_more: false,
            url: `/v1/charges/${CHARGE}/refunds`,
          },
        },
      ],
    });
    expect(res.ok).toBe(true);
  });

  afterAll(async () => {
    for (const rehearsal of [a, b]) await teardownSnapshot(rehearsal, "cancelled");
  });

  it("reaches its own rh- tenant and no other rehearsal's", async () => {
    const worldsA = rehearsalWorkerWorlds(a, workerEnv, { fetch: operator });
    const worldsB = rehearsalWorkerWorlds(b, workerEnv, { fetch: operator });
    expect((await read(worldsA.stripe, `/v1/charges/${CHARGE}`)).status).toBe(200);
    expect((await read(worldsB.stripe, `/v1/charges/${CHARGE}`)).status).toBe(404);
  });

  it("fails closed when configured for the operational container, before any request", async () => {
    const operational = resolveWorld("stripe", "operational", operatorEnv).baseUrl;
    const worlds = rehearsalWorkerWorlds(
      a,
      { ...workerEnv, ERA_STRIPE_REHEARSAL_URL: operational },
      { fetch: operator },
    );
    await expect(read(worlds.stripe, "/v1/charges?limit=1")).rejects.toThrow(
      /no valid Era tenant token: minted for http/,
    );
  });

  it("records why the URL check matters: another container serves the token as `default`", async () => {
    // Surprise 16. A rehearsal token at the operational container isn't rejected: it reads that
    // container's default tenant. Read-only here; the tenant is never the demo's.
    const worlds = rehearsalWorkerWorlds(a, workerEnv, { fetch: operator });
    const token = await (worlds.stripe.tenantToken as { get(): Promise<string> }).get();
    const operational = resolveWorld("stripe", "operational", operatorEnv);
    const res = await read({ ...operational, tenantToken: token }, "/v1/charges?limit=1");
    expect(res.status).toBe(200);
    const ownCharge = await read({ ...operational, tenantToken: token }, `/v1/charges/${CHARGE}`);
    expect(ownCharge.status).toBe(404);
  });
});
