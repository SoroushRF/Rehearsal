import { createReadGuard, executeRun, planHash } from "@rehearsal/core";
import {
  eraAdmin,
  type WorldConfig,
  withWriter,
  zendeskReader,
  zendeskWriter,
} from "@rehearsal/providers";
import {
  billingManifest,
  incidentRecords,
  MemoryApplyStore,
  MemoryJournal,
} from "@rehearsal/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminToken,
  ENABLED,
  getTicket,
  resetScratchTenants,
  scratchWorld,
  uniqueTenant,
  zendeskPutTicket,
} from "../src/harness";

describe.skipIf(!ENABLED)("precondition/guard race on Era", () => {
  let world: WorldConfig;
  const tenant = uniqueTenant("guard-order");
  beforeAll(async () => {
    world = await scratchWorld("zendesk", "operational", tenant);
    const res = await eraAdmin(world, adminToken(), "/inject", incidentRecords().zendesk);
    if (!res.ok) throw new Error(`inject failed: ${res.status}`);
  });
  afterAll(resetScratchTenants);

  it("holds an intervening teammate edit rather than accepting its fresh stamp", async () => {
    const ctx = { world: "operational", tenant } as const;
    const target = {
      world: "operational",
      config: world,
      authorization: "Bearer guard-order",
    } as const;
    const reader = zendeskReader(target);
    const provider = withWriter(reader, zendeskWriter(target));
    const obs = await reader.observe({ vendor: "zendesk", kind: "ticket", id: "9100001" }, ctx);
    const manifest = billingManifest(`plan_${tenant}`);
    const patch = manifest.actions.find((a) => a.kind === "zendesk.ticket.patchFields");
    if (patch?.kind !== "zendesk.ticket.patchFields") throw new Error("no patch");
    patch.args.ticketId = "9100001";
    patch.evidence = [obs.id];
    manifest.actions = [patch];
    manifest.observations = [{ ...obs, world: "planning" }];
    manifest.queryObservations = [];
    const hash = planHash(manifest);
    const store = new MemoryApplyStore();
    const job = {
      orgId: manifest.orgId,
      planId: manifest.planId,
      revision: 1,
      planHash: hash,
      runId: "run",
    };
    store.runs.set("run", { ...job, approvalId: "grant" });
    store.plans.set(`${manifest.planId}@1`, { planHash: hash, manifest });
    store.grants.set("grant", {
      id: "grant",
      orgId: manifest.orgId,
      planId: manifest.planId,
      revision: 1,
      planHash: hash,
      actorUserId: "review",
      actorSessionId: "review",
      roles: ["support_lead"],
      revokedAt: null,
      grantedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const readPrecondition = provider.preconditions;
    provider.preconditions = async (action, context) => {
      const edit = await zendeskPutTicket(world, 9100001, { priority: "urgent" });
      expect(edit.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      return readPrecondition?.(action, context) ?? {};
    };
    const providers = { zendesk: provider },
      worlds = { zendesk: ctx },
      clock = { now: () => new Date() };
    let seq = 0;
    const out = await executeRun(job, {
      store,
      providers,
      worlds,
      clock,
      journal: new MemoryJournal(),
      newId: (p) => `${p}_${++seq}`,
      policies: [
        { id: "billing-remedy", version: 1, currency: "cad", financeThresholdMinor: 10_000 },
      ],
      guard: createReadGuard({ providers, worlds, clock }),
    });
    expect(out.receipts[0]).toMatchObject({
      outcome: "held",
      holdReason: { kind: "row_changed", fields: ["priority"] },
    });
    expect((await getTicket(world, 9100001)).priority).toBe("urgent");
  });
});
