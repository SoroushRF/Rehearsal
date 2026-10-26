import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { orgTenant } from "@rehearsal/core";
import {
  eraFetch,
  mintTenantToken,
  resolveWorld,
  type WorldConfig,
  workerWorlds,
} from "@rehearsal/providers";
import { incidentRecords, problemRecords } from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../../apps/api/src/app";
import { readOperationalWorld } from "../../../apps/api/src/company";
import { ensureOrgSeeded, resetOrgWorlds } from "../../../apps/api/src/org-worlds";
import { eraProblemInjector } from "../../../apps/api/src/problems";
import { tenantTokenDepsFromEnv } from "../../../apps/api/src/tenant-tokens";
import { ENABLED } from "../src/harness";

/**
 * #330 on Era: each org gets its own tenant in the planning and operational worlds, seeded with
 * the demo cohort on first use, and one org's write never shows in another org's overview.
 * Needs `pnpm infra:up` and `ERA_CONFORMANCE=1` with ERA_ADMIN_TOKEN set.
 */
describe.skipIf(!ENABLED)("one Era tenant per org (#330)", () => {
  async function bound(world: "planning" | "operational", orgId: string): Promise<WorldConfig> {
    const config = resolveWorld("stripe", world, process.env, orgTenant(orgId));
    const { token } = await mintTenantToken(config, process.env.ERA_ADMIN_TOKEN ?? "");
    return { ...config, tenantToken: token };
  }

  it("seeds each org's own tenants, and a refund in org A leaves org B as it was", async () => {
    const a = `org_${randomUUID()}`;
    const b = `org_${randomUUID()}`;
    await Promise.all([ensureOrgSeeded(a), ensureOrgSeeded(b)]);

    const cohort = incidentRecords();
    const found = cohort.stripe.charges.find((c) => c.currency === "cad");
    if (!found) throw new Error("no CAD charge in the cohort");
    const cohortCharge = { id: String(found.id), amount: Number(found.amount) };
    const beforeA = await readOperationalWorld(a);
    const beforeB = await readOperationalWorld(b);
    // Seeded: the cohort's CAD charges are there in both, unrefunded.
    for (const before of [beforeA, beforeB]) {
      const row = before.charges.find((c) => c.id === cohortCharge.id);
      expect(row?.refundedMinor).toBe(0);
    }

    // An apply's write, in org A's operational tenant only.
    const opA = await bound("operational", a);
    const res = await eraFetch(opA, "/v1/refunds", {
      method: "POST",
      headers: {
        authorization: "Bearer sk_test_rehearsal_org_test",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ charge: cohortCharge.id }).toString(),
    });
    expect(res.ok).toBe(true);

    const afterA = await readOperationalWorld(a);
    const afterB = await readOperationalWorld(b);
    expect(afterA.charges.find((c) => c.id === cohortCharge.id)?.refundedMinor).toBe(
      cohortCharge.amount,
    );
    expect(afterB).toEqual(beforeB);
    // Org A's planning tenant, the copy the planner reads, is untouched too.
    const planA = await bound("planning", a);
    const charge = await eraFetch(planA, `/v1/charges/${cohortCharge.id}`, {
      headers: { authorization: "Bearer sk_test_rehearsal_org_test" },
    });
    expect(((await charge.json()) as { amount_refunded: number }).amount_refunded).toBe(0);

    // Seeding again changes nothing (the write in A survives).
    await ensureOrgSeeded(a);
    expect((await readOperationalWorld(a)).charges).toEqual(afterA.charges);
  }, 120_000);

  it("a worker reads an org's tenant through the operator only while it has that org's job", async () => {
    const org = `org_${randomUUID()}`;
    await ensureOrgSeeded(org);
    const working = new Set<string>([`executor:${org}`]);
    const deps = tenantTokenDepsFromEnv({
      ...process.env,
      PLANNER_WORKER_SECRET: "org-planner-secret",
      EXECUTOR_WORKER_SECRET: "org-executor-secret",
    });
    if (!deps) throw new Error("no minter");
    const app = buildApp({
      tenantTokens: { ...deps, hasWork: async (role, o) => working.has(`${role}:${o}`) },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const apiUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      const env = {
        REHEARSAL_API_URL: apiUrl,
        EXECUTOR_WORKER_SECRET: "org-executor-secret",
        ERA_STRIPE_OPERATIONAL_URL: process.env.ERA_STRIPE_OPERATIONAL_URL,
        ERA_ZENDESK_OPERATIONAL_URL: process.env.ERA_ZENDESK_OPERATIONAL_URL,
      };
      const worlds = workerWorlds("executor", env, { orgId: org });
      expect(worlds.stripe.tenant).toBe(orgTenant(org));
      const first = incidentRecords().stripe.charges[0];
      const read = (w: WorldConfig) =>
        eraFetch(w, `/v1/charges/${String(first?.id)}`, {
          headers: { authorization: "Bearer sk_test_rehearsal_org_test" },
        });
      expect((await read(worlds.stripe)).status).toBe(200);
      // Another org, with no job for this worker: the operator mints nothing, so nothing is read.
      const stranger = workerWorlds("executor", env, { orgId: `org_${randomUUID()}` });
      await expect(read(stranger.stripe)).rejects.toThrow(/403/);
    } finally {
      await app.close();
    }
  }, 120_000);

  it("a problem created in org A, and A's reset, leave org B as it was (#331)", async () => {
    const a = `org_${randomUUID()}`;
    const b = `org_${randomUUID()}`;
    await Promise.all([ensureOrgSeeded(a), ensureOrgSeeded(b)]);
    const seededA = await readOperationalWorld(a);
    const beforeB = await readOperationalWorld(b);

    const records = problemRecords("duplicate_charge", 2, `r${Date.now().toString(36)}`, 9_400_000);
    const inject = eraProblemInjector();
    if (!records || !inject) throw new Error("no injector");
    await inject(a, records);
    const ids = records.stripe.charges.map((c) => String(c.id));
    const withProblem = await readOperationalWorld(a);
    expect(ids.every((id) => withProblem.charges.some((c) => c.id === id))).toBe(true);
    expect(await readOperationalWorld(b)).toEqual(beforeB);

    await resetOrgWorlds(a);
    const resetA = await readOperationalWorld(a);
    expect(resetA.charges.map((c) => c.id).sort()).toEqual(seededA.charges.map((c) => c.id).sort());
    expect(await readOperationalWorld(b)).toEqual(beforeB);
  }, 120_000);
});
