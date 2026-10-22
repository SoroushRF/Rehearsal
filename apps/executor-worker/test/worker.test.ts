import { randomUUID } from "node:crypto";
import type { BillingPolicyV1 } from "@rehearsal/core";
import { planHash } from "@rehearsal/core";
import {
  APPLY_QUEUE,
  createDb,
  migrateDb,
  PgApplyStore,
  type PgBoss,
  requestApply,
  schema,
  startQueue,
} from "@rehearsal/db";
import { billingManifest, FakeClock, type FakeWorld, worldFromManifest } from "@rehearsal/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import policy from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import { handleApplyJob, RetryLater, type WorkerContext } from "../src/worker";

const NOW = new Date("2026-10-22T12:00:00.000Z");

// Needs a real Postgres: `pnpm infra:up` then `DB_TESTS=1 pnpm --filter @rehearsal/executor-worker test`.
describe.skipIf(!process.env.DB_TESTS)(
  "executor worker on Postgres + pg-boss (fake providers)",
  () => {
    const url =
      process.env.DATABASE_URL ?? "postgres://rehearsal:rehearsal@localhost:5432/rehearsal";
    const db = createDb(url);
    let boss: PgBoss;

    beforeAll(async () => {
      await migrateDb(db);
      boss = await startQueue(url);
    });
    afterAll(async () => {
      await boss?.stop({ graceful: false });
      await db.$client.end();
    });

    /** An approved plan in a fresh org with a run requested through the real apply command. */
    async function approvedRun() {
      const orgId = `org_${randomUUID()}`;
      const planId = `plan_${randomUUID()}`;
      const manifest = { ...billingManifest(planId), orgId };
      const hash = planHash(manifest);
      await db
        .insert(schema.planVersions)
        .values({ orgId, planId, revision: 1, planHash: hash, manifest });
      await db.insert(schema.approvalGrants).values({
        id: `grant_${randomUUID()}`,
        orgId,
        planId,
        revision: 1,
        planHash: hash,
        actorUserId: "user_finance",
        actorSessionId: "sess",
        roles: ["support_lead", "finance_lead"],
        grantedAt: new Date(NOW.getTime() - 3_600_000),
        expiresAt: new Date(NOW.getTime() + 3_600_000),
      });
      const accepted = await requestApply(db, boss, {
        orgId,
        userId: "user_finance",
        planId,
        revision: 1,
        planHash: hash,
        now: NOW,
      });
      if (accepted.kind !== "accepted") throw new Error(`apply refused: ${accepted.kind}`);
      const world = worldFromManifest(manifest.observations);
      return { orgId, planId, hash, runId: accepted.runId, manifest, world };
    }

    function contextFor(world: FakeWorld): WorkerContext {
      const providers = { stripe: world.provider("stripe"), zendesk: world.provider("zendesk") };
      return {
        db,
        providers,
        worlds: {
          stripe: { world: "operational", tenant: "test" },
          zendesk: { world: "operational", tenant: "test" },
        },
        clock: new FakeClock(NOW.toISOString()),
        policies: [policy as BillingPolicyV1],
        executor: { sleep: async () => {} },
      };
    }

    const runState = async (runId: string) =>
      (await db.select().from(schema.runs)).find((r) => r.id === runId)?.state;

    async function waitFor(check: () => Promise<boolean>, ms = 15_000) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("timed out");
    }

    it("consumes the apply job end to end: run completed, receipts journaled, effects applied once", async () => {
      const r = await approvedRun();
      const ctx = contextFor(r.world);
      // A private queue name would need its own producer; instead consume the shared queue but only
      // act on our own run's job, completing others untouched for their own tests.
      // Other tests leave unconsumed jobs in the shared queue: drain in batches, act on ours only.
      const workerId = await boss.work(
        APPLY_QUEUE,
        { batchSize: 100, pollingIntervalSeconds: 0.5 },
        async (jobs) => {
          for (const job of jobs) {
            if ((job.data as { runId?: string }).runId === r.runId)
              await handleApplyJob(job.data, ctx);
          }
        },
      );
      try {
        await waitFor(async () => (await runState(r.runId)) === "completed");
      } finally {
        await boss.offWork(APPLY_QUEUE, { id: workerId });
      }
      const receipts = (await db.select().from(schema.stepReceipts)).filter(
        (x) => x.orgId === r.orgId,
      );
      expect(receipts.map((x) => x.actionId).sort()).toEqual(
        r.manifest.actions.map((a) => a.id).sort(),
      );
      expect(r.world.refunds).toHaveLength(2);
    }, 30_000);

    it("a job delivered twice is a no-op the second time", async () => {
      const r = await approvedRun();
      const ctx = contextFor(r.world);
      const data = {
        orgId: r.orgId,
        runId: r.runId,
        planId: r.planId,
        revision: 1,
        planHash: r.hash,
      };
      expect((await handleApplyJob(data, ctx)).state).toBe("completed");
      const effects = r.world.effects.length;
      expect((await handleApplyJob(data, ctx)).state).toBe("completed");
      expect(r.world.effects.length).toBe(effects);
      expect(await runState(r.runId)).toBe("completed");
    });

    it("defers when another run of the plan holds the lock, leaving the run approved", async () => {
      const r = await approvedRun();
      const ctx = contextFor(r.world);
      const release = await new PgApplyStore(createDb(url)).lockPlan(r.orgId, r.planId);
      try {
        const data = {
          orgId: r.orgId,
          runId: r.runId,
          planId: r.planId,
          revision: 1,
          planHash: r.hash,
        };
        await expect(handleApplyJob(data, ctx)).rejects.toBeInstanceOf(RetryLater);
        expect(await runState(r.runId)).toBe("approved");
        expect(r.world.effects).toEqual([]);
      } finally {
        await release?.();
      }
    });

    it("records an honest partial state", async () => {
      const r = await approvedRun();
      r.world.fault("/v1/refunds", { kind: "reject", status: 402, retryable: false });
      const data = {
        orgId: r.orgId,
        runId: r.runId,
        planId: r.planId,
        revision: 1,
        planHash: r.hash,
      };
      expect((await handleApplyJob(data, contextFor(r.world))).state).toBe("partial");
      expect(await runState(r.runId)).toBe("partial");
    });

    it("refuses a malformed job payload before touching anything", async () => {
      const r = await approvedRun();
      await expect(handleApplyJob({ runId: r.runId }, contextFor(r.world))).rejects.toThrow();
      expect(await runState(r.runId)).toBe("approved");
    });
  },
);
