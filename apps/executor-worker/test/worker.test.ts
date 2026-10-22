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
import { type ApplyJobResult, handleApplyJob, RetryLater, type WorkerContext } from "../src/worker";

const stateOf = (r: ApplyJobResult) =>
  r.kind === "ran" ? r.outcome.state : `skipped: ${r.reason}`;

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

    it("a job delivered twice is skipped the second time", async () => {
      const r = await approvedRun();
      const ctx = contextFor(r.world);
      const data = {
        orgId: r.orgId,
        runId: r.runId,
        planId: r.planId,
        revision: 1,
        planHash: r.hash,
      };
      expect(stateOf(await handleApplyJob(data, ctx))).toBe("completed");
      const effects = r.world.effects.length;
      expect(stateOf(await handleApplyJob(data, ctx))).toBe("skipped: run is completed");
      expect(r.world.effects.length).toBe(effects);
      expect(await runState(r.runId)).toBe("completed");
    });

    it("defers when another run of the plan holds the lock, leaving the run applying", async () => {
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
        expect(await runState(r.runId)).toBe("applying");
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
      expect(stateOf(await handleApplyJob(data, contextFor(r.world)))).toBe("partial");
      expect(await runState(r.runId)).toBe("partial");
    });

    /** Pause the first delivery mid-dispatch (after a refund was sent) until released. */

    function pausedContext(world: FakeWorld) {
      const ctx = contextFor(world);

      const stripe = world.provider("stripe");

      let release: () => void = () => {};

      const gate = new Promise<void>((r) => {
        release = r;
      });

      let reached: () => void = () => {};

      const paused = new Promise<void>((r) => {
        reached = r;
      });

      let first = true;

      const providers = {
        ...ctx.providers,

        stripe: {
          ...stripe,

          dispatch: async (
            req: Parameters<typeof stripe.dispatch>[0],
            c: Parameters<typeof stripe.dispatch>[1],
          ) => {
            const res = await stripe.dispatch(req, c);

            if (first) {
              first = false;

              reached();

              await gate;
            }

            return res;
          },
        },
      };

      return { ctx: { ...ctx, providers }, paused, release: () => release() };
    }

    it.each([
      ["a normal retry", undefined],

      ["the last retry", { retryCount: 50, retryLimit: 50 }],
    ] as const)(
      "an overlapping redelivery on %s never overwrites the running delivery's outcome",

      async (_label, attempt) => {
        const r = await approvedRun();

        const { ctx, paused, release } = pausedContext(r.world);

        const a = handleApplyJob(jobOf(r), ctx); // holds the plan lock, paused after its first refund

        await paused;

        const b = handleApplyJob(jobOf(r), contextFor(r.world), attempt);

        if (attempt) await b;
        else await expect(b).rejects.toBeInstanceOf(RetryLater);

        expect(await runState(r.runId)).toBe(attempt ? "failed" : "applying");

        release();

        expect(stateOf(await a)).toBe("completed");

        expect(await runState(r.runId)).toBe("completed");

        expect(r.world.refunds).toHaveLength(2);
      },
    );

    it("skips a malformed job payload without retrying or touching anything", async () => {
      const r = await approvedRun();
      expect(await handleApplyJob({ runId: r.runId }, contextFor(r.world))).toEqual({
        kind: "skipped",
        reason: "malformed apply job",
      });
      expect(await runState(r.runId)).toBe("approved");
    });

    const jobOf = (r: Awaited<ReturnType<typeof approvedRun>>) => ({
      orgId: r.orgId,
      runId: r.runId,
      planId: r.planId,
      revision: 1,
      planHash: r.hash,
    });

    it("never applies a cancelled run, and leaves it cancelled", async () => {
      const r = await approvedRun();
      await new PgApplyStore(db).setRunState(r.orgId, r.runId, "cancelled");
      expect(await handleApplyJob(jobOf(r), contextFor(r.world))).toEqual({
        kind: "skipped",
        reason: "run is cancelled",
      });
      expect(r.world.effects).toEqual([]);
      expect(await runState(r.runId)).toBe("cancelled");
    });

    it("a redelivered job for a held run is skipped, even with a newer active run of that hash", async () => {
      const r = await approvedRun();
      await new PgApplyStore(db).setRunState(r.orgId, r.runId, "held");
      const newer = await requestApply(db, boss, {
        orgId: r.orgId,
        userId: "user_finance",
        planId: r.planId,
        revision: 1,
        planHash: r.hash,
        now: NOW,
      });
      expect(newer).toMatchObject({ kind: "accepted", existing: false });
      expect(await handleApplyJob(jobOf(r), contextFor(r.world))).toEqual({
        kind: "skipped",
        reason: "run is held",
      });
      expect(await runState(r.runId)).toBe("held");
    });

    it("skips a job whose payload doesn't match the stored run", async () => {
      const r = await approvedRun();
      const result = await handleApplyJob(
        { ...jobOf(r), planHash: "f".repeat(64) },
        contextFor(r.world),
      );
      expect(result).toEqual({ kind: "skipped", reason: "job does not match a stored run" });
      expect(await runState(r.runId)).toBe("approved");
    });

    it("on the last retry, a run still blocked by the plan lock ends failed so it can be re-applied", async () => {
      const r = await approvedRun();
      const release = await new PgApplyStore(createDb(url)).lockPlan(r.orgId, r.planId);
      try {
        const result = await handleApplyJob(jobOf(r), contextFor(r.world), {
          retryCount: 50,
          retryLimit: 50,
        });
        expect(stateOf(result)).toBe("failed");
        expect(await runState(r.runId)).toBe("failed");
      } finally {
        await release?.();
      }
      const again = await requestApply(db, boss, {
        orgId: r.orgId,
        userId: "user_finance",
        planId: r.planId,
        revision: 1,
        planHash: r.hash,
        now: NOW,
      });
      expect(again).toMatchObject({ kind: "accepted", existing: false });
    });
  },
);
