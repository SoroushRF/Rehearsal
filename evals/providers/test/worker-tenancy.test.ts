import type { AddressInfo } from "node:net";
import { eraAdmin, resolveWorld, type WorldConfig, workerWorlds } from "@rehearsal/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../../apps/api/src/app";
import { tenantTokenDepsFromEnv } from "../../../apps/api/src/tenant-tokens";
import {
  adminToken,
  ENABLED,
  getJson,
  getTicket,
  SEED,
  stripePost,
  uniqueTenant,
  zendeskPutTicket,
} from "../src/harness";

const chargePath = `/v1/charges/${SEED.chargeId}`;

async function amountRefunded(world: WorldConfig): Promise<number> {
  return (await getJson<{ amount_refunded: number }>("stripe", world, chargePath)).amount_refunded;
}

// T1.9: the same isolation and reset checks as tenancy.test.ts, but every client world comes from
// the workers' own config: workerWorlds() minting through the API's operator route, which alone
// holds the admin token.
describe.skipIf(!ENABLED)("tenant isolation and reset through the workers' config", () => {
  const tenant = uniqueTenant("workers");
  const app = buildApp({
    tenantTokens: tenantTokenDepsFromEnv({
      ...process.env,
      ERA_TENANT: tenant,
      PLANNER_WORKER_SECRET: "conf-planner-secret",
      EXECUTOR_WORKER_SECRET: "conf-executor-secret",
    }),
  });
  let planner: ReturnType<typeof workerWorlds>;
  let executor: ReturnType<typeof workerWorlds>;
  let seedPriority: string | null;

  beforeAll(async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const apiUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    // Each worker sees only its own secret and world URLs, as its startup check requires.
    planner = workerWorlds("planner", {
      REHEARSAL_API_URL: apiUrl,
      PLANNER_WORKER_SECRET: "conf-planner-secret",
      ERA_STRIPE_PLANNING_URL: process.env.ERA_STRIPE_PLANNING_URL,
      ERA_ZENDESK_PLANNING_URL: process.env.ERA_ZENDESK_PLANNING_URL,
      ERA_TENANT: tenant,
    });
    executor = workerWorlds("executor", {
      REHEARSAL_API_URL: apiUrl,
      EXECUTOR_WORKER_SECRET: "conf-executor-secret",
      ERA_STRIPE_OPERATIONAL_URL: process.env.ERA_STRIPE_OPERATIONAL_URL,
      ERA_ZENDESK_OPERATIONAL_URL: process.env.ERA_ZENDESK_OPERATIONAL_URL,
      ERA_TENANT: tenant,
    });
    seedPriority = (await getTicket(planner.zendesk, SEED.ticketId)).priority;
  });

  afterAll(async () => {
    for (const vendor of ["stripe", "zendesk"] as const) {
      for (const world of ["planning", "operational"] as const) {
        await eraAdmin({ ...resolveWorld(vendor, world), tenant }, adminToken(), "/reset");
      }
    }
    await app.close();
  });

  it("keeps the planner's writes in its own tenant of the planning world", async () => {
    const res = await stripePost(
      planner.stripe,
      "/v1/refunds",
      `charge=${SEED.chargeId}&amount=2500`,
      `rehearsal-op-${tenant}`,
    );
    expect(res.status).toBe(200);
    const refundId = ((await res.json()) as { id: string }).id;
    expect(
      (await zendeskPutTicket(planner.zendesk, SEED.ticketId, { priority: "urgent" })).status,
    ).toBe(200);

    expect(await amountRefunded(planner.stripe)).toBe(2500);
    expect((await getTicket(planner.zendesk, SEED.ticketId)).priority).toBe("urgent");

    // Not in the operational world, even in the same tenant.
    expect(await amountRefunded(executor.stripe)).toBe(0);
    expect((await getTicket(executor.zendesk, SEED.ticketId)).priority).toBe(seedPriority);

    // An unsigned request naming the same tenant lands in "default" and does not see the write.
    const plaintext: WorldConfig = { ...resolveWorld("stripe", "planning"), tenant };
    const refundsPath = `/v1/refunds?charge=${SEED.chargeId}&limit=100`;
    const signedView = await getJson<{ data: Array<{ id: string }> }>(
      "stripe",
      planner.stripe,
      refundsPath,
    );
    expect(signedView.data.map((r) => r.id)).toEqual([refundId]);
    expect(await getJson("stripe", plaintext, refundsPath)).not.toEqual(signedView);
  });

  it("drops the tenant's writes on reset and keeps the worker's token valid", async () => {
    await eraAdmin({ ...resolveWorld("stripe", "planning"), tenant }, adminToken(), "/reset");
    await eraAdmin({ ...resolveWorld("zendesk", "planning"), tenant }, adminToken(), "/reset");

    expect(await amountRefunded(planner.stripe)).toBe(0);
    expect((await getTicket(planner.zendesk, SEED.ticketId)).priority).toBe(seedPriority);
  });
});
