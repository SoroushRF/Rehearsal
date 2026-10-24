import { randomUUID } from "node:crypto";
import type { BillingPolicyV1 } from "@rehearsal/core";
import { planHash } from "@rehearsal/core";
import {
  APPLY_QUEUE,
  createDb,
  MAX_REAPS,
  migrateDb,
  PgApplyStore,
  type PgBoss,
  PgJournal,
  reapStuckRuns,
  requestApply,
  requestCancel,
  schema,
  startQueue,
} from "@rehearsal/db";
import { billingManifest, FakeClock, type FakeWorld, worldFromManifest } from "@rehearsal/testkit";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

        // Even on the last try it never marks the run failed: the holder may have sent something.
        await expect(b).rejects.toBeInstanceOf(RetryLater);

        expect(await runState(r.runId)).toBe("applying");

        release();

        expect(stateOf(await a)).toBe("completed");

        expect(await runState(r.runId)).toBe("completed");

        expect(r.world.refunds).toHaveLength(2);
      },
    );

    it("a human cancel during a run stops it before the next action, and it stays cancelled", async () => {
      const r = await approvedRun();

      const { ctx, paused, release } = pausedContext(r.world);

      const a = handleApplyJob(jobOf(r), ctx); // paused right after its first refund

      await paused;

      expect(await requestCancel(db, { orgId: r.orgId, runId: r.runId })).toMatchObject({
        kind: "cancelled",
      });

      release();

      expect(stateOf(await a)).toBe("cancelled");

      expect(await runState(r.runId)).toBe("cancelled");

      expect(r.world.refunds).toHaveLength(1);

      const receipts = (await db.select().from(schema.stepReceipts)).filter(
        (x) => x.orgId === r.orgId,
      );

      expect(receipts.map((x) => x.actionId)).toEqual(["refund_001"]);
    });

    it("a stale delivery after the grant was revoked defers to the running one; never marks it failed", async () => {
      const r = await approvedRun();

      const { ctx, paused, release } = pausedContext(r.world);

      const a = handleApplyJob(jobOf(r), ctx);

      await paused;

      await db

        .update(schema.approvalGrants)

        .set({ revokedAt: NOW })

        .where(eq(schema.approvalGrants.orgId, r.orgId));

      await expect(handleApplyJob(jobOf(r), contextFor(r.world))).rejects.toBeInstanceOf(
        RetryLater,
      );

      expect(await runState(r.runId)).toBe("applying");

      release();

      await a; // the holder sees the revocation before its next send and holds

      expect(await runState(r.runId)).not.toBe("failed");

      expect(r.world.refunds).toHaveLength(1);
    });

    it("a cancelled run's job still resolves an in-flight refund by reading, and stays cancelled", async () => {
      const r = await approvedRun();

      const ctx = contextFor(r.world);

      const stripe = r.world.provider("stripe");

      const losing = {
        ...ctx,

        providers: {
          ...ctx.providers,

          stripe: {
            ...stripe,

            dispatch: async (
              req: Parameters<typeof stripe.dispatch>[0],
              c: Parameters<typeof stripe.dispatch>[1],
            ) => {
              await stripe.dispatch(req, c);

              return { kind: "unknown" as const, error: "response lost (injected)" };
            },
          },
        },

        executor: { sleep: async () => {}, retry: { maxAttempts: 1 } },
      };

      await handleApplyJob(jobOf(r), losing);

      expect(await requestCancel(db, { orgId: r.orgId, runId: r.runId })).toMatchObject({
        kind: "not_active",
      });

      await new PgApplyStore(db).setRunState(r.orgId, r.runId, "cancelled");

      const result = await handleApplyJob(jobOf(r), contextFor(r.world));

      expect(stateOf(result)).toBe("cancelled");

      expect(await runState(r.runId)).toBe("cancelled");

      const receipts = (await db.select().from(schema.stepReceipts)).filter(
        (x) => x.orgId === r.orgId,
      );

      const confirmed = receipts.filter(
        (x) => (x.receipt as { outcome: string }).outcome === "confirmed",
      );

      expect(confirmed.map((x) => x.actionId).sort()).toEqual([
        "patch_001",
        "patch_002",
        "refund_001",
        "refund_002",
      ]);

      expect(r.world.refunds).toHaveLength(2);

      expect(r.world.tickets.get("5531")?.comments).toHaveLength(0);
    });

    it("runs independent cases at once against the Postgres journal, each effect once", async () => {
      const r = await approvedRun();

      const ctx = {
        ...contextFor(r.world),
        executor: { sleep: async () => {}, caseConcurrency: 2 },
      };

      expect(stateOf(await handleApplyJob(jobOf(r), ctx))).toBe("completed");

      const receipts = (await db.select().from(schema.stepReceipts)).filter(
        (x) => x.orgId === r.orgId,
      );

      expect(receipts).toHaveLength(r.manifest.actions.length);

      expect(r.world.refunds).toHaveLength(2);
    });

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

    it("never applies a cancelled run (a read-only pass sends nothing), and leaves it cancelled", async () => {
      const r = await approvedRun();
      await new PgApplyStore(db).setRunState(r.orgId, r.runId, "cancelled");
      expect(stateOf(await handleApplyJob(jobOf(r), contextFor(r.world)))).toBe("cancelled");
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

    /** Fail the journal's settle transaction for `actionId`'s confirmed receipt, `times` times. */
    function failSettle(actionId: string, times = 1) {
      const settle = PgJournal.prototype.settle;
      let left = times;
      const spy = vi.spyOn(PgJournal.prototype, "settle").mockImplementation(function (
        this: PgJournal,
        step,
      ) {
        if (step.receipt.actionId === actionId && left > 0) {
          left--;
          return Promise.reject(new Error("settle failed (injected)"));
        }
        return settle.call(this, step);
      });
      return spy;
    }

    const refundReceipt = async (orgId: string) =>
      (await db.select().from(schema.stepReceipts))
        .filter((x) => x.orgId === orgId && x.actionId === "refund_001")
        .map((x) => (x.receipt as { outcome: string }).outcome);

    it("retries a run whose executor returned an error, and reconciles the effect it left (#104)", async () => {
      const r = await approvedRun();
      const ctx = contextFor(r.world);
      // The refund lands, then its settle transaction fails: the attempt stays dispatched.
      const spy = failSettle("refund_001");
      try {
        await expect(
          handleApplyJob(jobOf(r), ctx, { retryCount: 0, retryLimit: 3 }),
        ).rejects.toBeInstanceOf(RetryLater);
      } finally {
        spy.mockRestore();
      }
      expect(await runState(r.runId)).toBe("applying");
      expect(r.world.refunds.filter((x) => x.charge === "ch_fixture_001")).toHaveLength(1);

      // The redelivery reads the refund back instead of sending another one.
      const again = await handleApplyJob(jobOf(r), ctx, { retryCount: 1, retryLimit: 3 });
      expect(stateOf(again)).toBe("completed");
      expect(await runState(r.runId)).toBe("completed");
      expect(r.world.refunds.filter((x) => x.charge === "ch_fixture_001")).toHaveLength(1);
      expect(await refundReceipt(r.orgId)).toEqual(["confirmed"]);
    });

    it("past the last retry, a run whose executor returned an error stays applying for the reaper (#104)", async () => {
      const r = await approvedRun();
      const spy = failSettle("refund_001");
      try {
        await expect(
          handleApplyJob(jobOf(r), contextFor(r.world), { retryCount: 3, retryLimit: 3 }),
        ).rejects.toBeInstanceOf(RetryLater);
      } finally {
        spy.mockRestore();
      }
      // Not failed: the refund has no receipt yet, so the reaper must still pick the run up
      // (bounded by MAX_REAPS, then `run.needs_operator`).
      expect(await runState(r.runId)).toBe("applying");
      // The reaper's re-enqueued job resumes it from the journal: read back, not sent again.
      const resumed = await handleApplyJob(jobOf(r), contextFor(r.world));
      expect(stateOf(resumed)).toBe("completed");
      expect(r.world.refunds.filter((x) => x.charge === "ch_fixture_001")).toHaveLength(1);
      expect(await refundReceipt(r.orgId)).toEqual(["confirmed"]);
    });

    it("a run retried after errors repeats no receipt and is never reported finished meanwhile", async () => {
      const r = await approvedRun();
      // A teammate edit holds case 1's patch and note; settling refund_002 fails on every pass.
      r.world.teammateEdit("5531", "priority", "urgent");
      const spy = failSettle("refund_002", Number.POSITIVE_INFINITY);
      try {
        for (let i = 0; i < 3; i++) {
          await expect(
            handleApplyJob(jobOf(r), contextFor(r.world), { retryCount: i, retryLimit: 5 }),
          ).rejects.toBeInstanceOf(RetryLater);
        }
      } finally {
        spy.mockRestore();
      }
      const receipts = (await db.select().from(schema.stepReceipts)).filter(
        (x) => x.orgId === r.orgId,
      );
      const per = (id: string) => receipts.filter((x) => x.actionId === id).length;
      expect(per("patch_001")).toBe(1);
      expect(per("note_001")).toBe(1);
      const events = (await db.select().from(schema.runEvents)).filter((e) => e.runId === r.runId);
      expect(events.filter((e) => e.type === "run.stopped")).toHaveLength(3);
      expect(events.some((e) => e.type === "run.finished")).toBe(false);
      expect(r.world.refunds.filter((x) => x.charge === "ch_fixture_002")).toHaveLength(1);

      // Once the journal recovers, the retry finishes and records the refund it left.
      const done = await handleApplyJob(jobOf(r), contextFor(r.world), {
        retryCount: 3,
        retryLimit: 5,
      });
      expect(stateOf(done)).toBe("partial");
      expect(r.world.refunds.filter((x) => x.charge === "ch_fixture_002")).toHaveLength(1);
    });

    it("retries a cancelled run's read-only pass that returned an error, and it stays cancelled (#104)", async () => {
      const r = await approvedRun();
      const ctx = contextFor(r.world);
      const stripe = r.world.provider("stripe");
      // The first refund lands but its response is lost.
      await handleApplyJob(jobOf(r), {
        ...ctx,
        providers: {
          ...ctx.providers,
          stripe: {
            ...stripe,
            dispatch: async (req, c) => {
              await stripe.dispatch(req, c);
              return { kind: "unknown" as const, error: "response lost (injected)" };
            },
          },
        },
        executor: { sleep: async () => {}, retry: { maxAttempts: 1 } },
      });
      await new PgApplyStore(db).setRunState(r.orgId, r.runId, "cancelled");

      const spy = failSettle("refund_001");
      try {
        await expect(
          handleApplyJob(jobOf(r), ctx, { retryCount: 0, retryLimit: 3 }),
        ).rejects.toBeInstanceOf(RetryLater);
      } finally {
        spy.mockRestore();
      }
      expect(await runState(r.runId)).toBe("cancelled");
      expect(stateOf(await handleApplyJob(jobOf(r), ctx))).toBe("cancelled");
      expect(await refundReceipt(r.orgId)).toContain("confirmed");
      expect(r.world.refunds).toHaveLength(2);
    });

    it("past the last retry, a run still blocked by the plan lock stays applying for the reaper (#121)", async () => {
      const r = await approvedRun();
      const release = await new PgApplyStore(createDb(url)).lockPlan(r.orgId, r.planId);
      try {
        await expect(
          handleApplyJob(jobOf(r), contextFor(r.world), { retryCount: 50, retryLimit: 50 }),
        ).rejects.toBeInstanceOf(RetryLater);
        // The holder may have sent something this delivery can't see: never mark it failed here.
        expect(await runState(r.runId)).toBe("applying");
      } finally {
        await release?.();
      }
    });

    it("an overlapping delivery's last lock retry never strands the holder's unreceipted refund (#121)", async () => {
      const r = await approvedRun();
      const ctx = contextFor(r.world);
      const stripe = r.world.provider("stripe");
      let landed = () => {};
      const refundLanded = new Promise<void>((res) => {
        landed = res;
      });
      let resume = () => {};
      const gate = new Promise<void>((res) => {
        resume = res;
      });
      let paused = false;
      const pausing: WorkerContext = {
        ...ctx,
        providers: {
          ...ctx.providers,
          stripe: {
            ...stripe,
            dispatch: async (req, c) => {
              const res = await stripe.dispatch(req, c);
              if (!paused) {
                paused = true;
                landed();
                await gate; // the refund is committed; the response hasn't come back yet
              }
              return res;
            },
          },
        },
      };
      // Delivery A holds the plan lock, its refund committed but unanswered.
      const a = handleApplyJob(jobOf(r), pausing, { retryCount: 0, retryLimit: 50 });
      await refundLanded;
      // Delivery B of the same job, on its last try, can't get the lock.
      await expect(
        handleApplyJob(jobOf(r), ctx, { retryCount: 50, retryLimit: 50 }),
      ).rejects.toBeInstanceOf(RetryLater);
      // A's refund settle then fails once, so A returns an executor error.
      const spy = failSettle("refund_001");
      try {
        resume();
        await expect(a).rejects.toBeInstanceOf(RetryLater);
      } finally {
        spy.mockRestore();
      }
      expect(await runState(r.runId)).toBe("applying");

      const again = await handleApplyJob(jobOf(r), ctx, { retryCount: 1, retryLimit: 50 });
      expect(stateOf(again)).toBe("completed");
      expect(r.world.refunds.filter((x) => x.charge === "ch_fixture_001")).toHaveLength(1);
      expect(await refundReceipt(r.orgId)).toEqual(["confirmed"]);
    });

    /** The same worker context with the clock past the approval's expiry (NOW + 1 h). */
    const expired = (world: FakeWorld): WorkerContext => ({
      ...contextFor(world),
      clock: new FakeClock(new Date(NOW.getTime() + 2 * 3_600_000).toISOString()),
    });

    /**
     * Revision 1 compensates case 2 (its note is refused), but the undo's response is lost: the
     * undo reaches the ticket only if `lands`. Revision 2, identical, is then approved; the test
     * runs it after its approval expired.
     */
    async function lostUndoThenRevision(lands: boolean) {
      const r = await approvedRun();
      const ctx = contextFor(r.world);
      const zendesk = ctx.providers.zendesk;
      if (!zendesk) throw new Error("no zendesk provider");
      let undoLost = false;
      const losing: WorkerContext = {
        ...ctx,
        providers: {
          ...ctx.providers,
          zendesk: {
            ...zendesk,
            dispatch: async (req, c) => {
              const onTicket = req.path === "/api/v2/tickets/5532.json";
              const comment = req.body.includes('"comment"');
              if (onTicket && comment && req.body.includes("safe_update") && !undoLost) {
                undoLost = true; // the undo: a guarded patch carrying its operation marker
                if (lands) await zendesk.dispatch(req, c);
                return { kind: "unknown" as const, error: "undo unanswered (injected)" };
              }
              if (onTicket && comment) {
                return { kind: "rejected" as const, status: 422, body: {}, retryable: false };
              }
              return zendesk.dispatch(req, c);
            },
          },
        },
      };
      await handleApplyJob(jobOf(r), losing);
      expect(undoLost).toBe(true);
      expect(r.world.tickets.get("5532")?.priority).toBe(lands ? "normal" : "high");

      const manifest2 = { ...r.manifest, revision: 2, parentRevision: 1 };
      const hash2 = planHash(manifest2);
      await db.insert(schema.planVersions).values({
        orgId: r.orgId,
        planId: r.planId,
        revision: 2,
        planHash: hash2,
        manifest: manifest2,
      });
      await db.insert(schema.approvalGrants).values({
        id: `grant_${randomUUID()}`,
        orgId: r.orgId,
        planId: r.planId,
        revision: 2,
        planHash: hash2,
        actorUserId: "user_finance",
        actorSessionId: "sess",
        roles: ["support_lead", "finance_lead"],
        grantedAt: new Date(NOW.getTime() - 3_600_000),
        expiresAt: new Date(NOW.getTime() + 3_600_000),
      });
      const rev2 = await requestApply(db, boss, {
        orgId: r.orgId,
        userId: "user_finance",
        planId: r.planId,
        revision: 2,
        planHash: hash2,
        now: NOW,
      });
      if (rev2.kind !== "accepted") throw new Error(`apply refused: ${rev2.kind}`);
      const job2 = { ...jobOf(r), runId: rev2.runId, revision: 2, planHash: hash2 };
      const undoAttempts = async () =>
        (await db.select().from(schema.stepAttempts))
          .filter((a) => a.orgId === r.orgId && a.actionId === "patch_002")
          .filter((a) => a.request && JSON.stringify(a.request).includes("comment"))
          .map((a) => a.state);
      const patchReceipts2 = async () =>
        (await db.select().from(schema.stepReceipts))
          .filter((x) => x.orgId === r.orgId && x.planHash === hash2 && x.actionId === "patch_002")
          .map((x) => (x.receipt as { outcome: string }).outcome);
      return { r, job2, undoAttempts, patchReceipts2, writes: r.world.effects.length };
    }

    it("a refused newer revision records an older revision's landed undo, with no hand-off (#124)", async () => {
      const { r, job2, undoAttempts, patchReceipts2, writes } = await lostUndoThenRevision(true);
      expect(await undoAttempts()).toEqual(["unknown_outcome"]);

      const result = await handleApplyJob(job2, expired(r.world), {
        retryCount: 0,
        retryLimit: 50,
      });
      expect(result).toMatchObject({ kind: "ran", outcome: { refusal: "grant expired" } });
      expect(stateOf(result)).toBe("failed"); // final: nothing left for the reaper or an operator
      expect(await runState(job2.runId)).toBe("failed");
      expect(await patchReceipts2()).toEqual(["compensated"]);
      expect(await undoAttempts()).toEqual(["reconciled"]);
      expect(r.world.tickets.get("5532")?.priority).toBe("normal");
      expect(r.world.effects.length).toBe(writes); // no fresh undo, no replay, no forward patch
    });

    it("a refused newer revision keeps an older revision's absent undo unresolved and retryable (#124)", async () => {
      const { r, job2, undoAttempts, patchReceipts2, writes } = await lostUndoThenRevision(false);
      await expect(
        handleApplyJob(job2, expired(r.world), { retryCount: 50, retryLimit: 50 }),
      ).rejects.toBeInstanceOf(RetryLater);
      expect(await runState(job2.runId)).toBe("applying");
      expect(await patchReceipts2()).toEqual(["held"]);
      expect(await undoAttempts()).toEqual(["unknown_outcome"]);
      expect(r.world.tickets.get("5532")?.priority).toBe("high");
      expect(r.world.effects.length).toBe(writes);
    });

    describe.each([
      ["absent", { lands: false, unreadable: false }],
      ["unreadable", { lands: true, unreadable: true }],
    ])("a cancelled newer revision with an older revision's %s undo (#124)", (_n, how) => {
      /** rev 2 is cancelled before its job runs; its worker can't read Zendesk if `unreadable`. */
      async function cancelledRev2() {
        const lost = await lostUndoThenRevision(how.lands);
        expect(
          await requestCancel(db, { orgId: lost.r.orgId, runId: lost.job2.runId }),
        ).toMatchObject({ kind: "cancelled" });
        const ctx = contextFor(lost.r.world);
        const zendesk = ctx.providers.zendesk;
        if (!zendesk) throw new Error("no zendesk provider");
        const rev2Ctx: WorkerContext = how.unreadable
          ? {
              ...ctx,
              providers: {
                ...ctx.providers,
                zendesk: {
                  ...zendesk,
                  reconcile: async () => {
                    throw new Error("zendesk read unavailable (injected)");
                  },
                },
              },
            }
          : ctx;
        return { ...lost, rev2Ctx };
      }

      it("its real queue delivery is retried, not completed, and it stays cancelled", async () => {
        const { r, job2, rev2Ctx, undoAttempts, writes } = await cancelledRev2();
        const thrown: unknown[] = [];
        const workerId = await boss.work(
          APPLY_QUEUE,
          { batchSize: 100, pollingIntervalSeconds: 0.5 },
          async (jobs) => {
            for (const job of jobs) {
              if ((job.data as { runId?: string }).runId !== job2.runId) continue;
              try {
                await handleApplyJob(job.data, rev2Ctx);
              } catch (err) {
                thrown.push(err);
                throw err;
              }
            }
          },
        );
        const jobState = async () =>
          (
            await db.execute<{ state: string }>(
              sql`select state::text from pgboss.job where name = ${APPLY_QUEUE}
                    and data->>'runId' = ${job2.runId}`,
            )
          ).rows.map((x) => x.state);
        try {
          await waitFor(async () => thrown.length > 0 && (await jobState()).includes("retry"));
        } finally {
          await boss.offWork(APPLY_QUEUE, { id: workerId });
        }
        expect(thrown[0]).toBeInstanceOf(RetryLater);
        expect(await jobState()).not.toContain("completed");
        expect(await runState(job2.runId)).toBe("cancelled");
        expect(await undoAttempts()).toEqual(["unknown_outcome"]);
        expect(r.world.effects.length).toBe(writes);
      }, 30_000);

      it("the reaper re-enqueues it, then hands it to an operator; it stays cancelled", async () => {
        const { r, job2, rev2Ctx, undoAttempts, writes } = await cancelledRev2();
        await expect(
          handleApplyJob(job2, rev2Ctx, { retryCount: 50, retryLimit: 50 }),
        ).rejects.toBeInstanceOf(RetryLater);
        /** pg-boss gave up on its job, and the run's last update is outside the stale window. */
        const exhaust = async () => {
          await db.execute(sql`delete from pgboss.job where data->>'runId' = ${job2.runId}`);
          await db
            .update(schema.runs)
            .set({ updatedAt: new Date(Date.now() - 3_600_000) })
            .where(eq(schema.runs.id, job2.runId));
        };
        const eventsOf = async (type: string) =>
          (await db.select().from(schema.runEvents)).filter(
            (e) => e.runId === job2.runId && e.type === type,
          ).length;
        /** Sweep until this run shows `type` (another suite's sweep may be the one that does it). */
        const sweepUntil = async (type: string, count: number) => {
          for (let i = 0; i < 50 && (await eventsOf(type)) < count; i++) {
            await reapStuckRuns(db, boss, { now: new Date(), staleAfterMs: 10 * 60_000 });
            if ((await eventsOf(type)) < count) await new Promise((res) => setTimeout(res, 50));
          }
          expect(await eventsOf(type)).toBe(count);
        };
        await exhaust();
        await sweepUntil("run.reaped", 1);
        // It was re-enqueued MAX_REAPS times in all; the next stale sweep hands it off.
        for (let n = 1; n < MAX_REAPS; n++) {
          await db
            .insert(schema.runEvents)
            .values({ orgId: r.orgId, runId: job2.runId, type: "run.reaped", payload: {} });
        }
        await exhaust();
        await sweepUntil("run.needs_operator", 1);
        expect(await runState(job2.runId)).toBe("cancelled");
        expect(await undoAttempts()).toEqual(["unknown_outcome"]);
        expect(r.world.effects.length).toBe(writes);
      }, 30_000);
    });

    it("an expired grant still reads back an unreceipted refund, and sends nothing new (#121)", async () => {
      const r = await approvedRun();
      const spy = failSettle("refund_001");
      try {
        await expect(
          handleApplyJob(jobOf(r), contextFor(r.world), { retryCount: 0, retryLimit: 50 }),
        ).rejects.toBeInstanceOf(RetryLater);
      } finally {
        spy.mockRestore();
      }
      const effects = r.world.effects.length;

      const after = await handleApplyJob(jobOf(r), expired(r.world), {
        retryCount: 1,
        retryLimit: 50,
      });
      expect(after).toMatchObject({ kind: "ran", outcome: { refusal: "grant expired" } });
      expect(stateOf(after)).toBe("failed");
      expect(await runState(r.runId)).toBe("failed");
      expect(await refundReceipt(r.orgId)).toEqual(["confirmed"]);
      expect(r.world.effects.length).toBe(effects); // read only: no new send, no replay
      expect(r.world.refunds.filter((x) => x.charge === "ch_fixture_001")).toHaveLength(1);
    });

    it("a run stranded by an expired grant and an unreadable send is reaped, then handed to an operator (#121)", async () => {
      const r = await approvedRun();
      const spy = failSettle("refund_001");
      try {
        await expect(
          handleApplyJob(jobOf(r), contextFor(r.world), { retryCount: 0, retryLimit: 50 }),
        ).rejects.toBeInstanceOf(RetryLater);
      } finally {
        spy.mockRestore();
      }
      const ctx = expired(r.world);
      const stripe = r.world.provider("stripe");
      const unreadable: WorkerContext = {
        ...ctx,
        providers: {
          ...ctx.providers,
          stripe: {
            ...stripe,
            reconcile: async () => {
              throw new Error("stripe read unavailable (injected)");
            },
          },
        },
      };
      // Past pg-boss's last try the run stays applying: the reaper's to hand off, not ours.
      await expect(
        handleApplyJob(jobOf(r), unreadable, { retryCount: 50, retryLimit: 50 }),
      ).rejects.toBeInstanceOf(RetryLater);
      expect(await runState(r.runId)).toBe("applying");

      // It was already re-enqueued MAX_REAPS times (the reaper's own tests cover selection), its
      // last job is gone and the run is stale. One sweep must hand it to an operator. Another
      // suite's sweep may be the one that does, so check the database, not this sweep's result.
      for (let n = 0; n < MAX_REAPS; n++) {
        await db.insert(schema.runEvents).values({
          orgId: r.orgId,
          runId: r.runId,
          type: "run.reaped",
          payload: {},
        });
      }
      await db.execute(sql`delete from pgboss.job where data->>'runId' = ${r.runId}`);
      await db
        .update(schema.runs)
        .set({ updatedAt: new Date(Date.now() - 3_600_000) })
        .where(eq(schema.runs.id, r.runId));
      const handedOff = async () =>
        (await db.select().from(schema.runEvents)).filter(
          (e) => e.runId === r.runId && e.type === "run.needs_operator",
        ).length;
      for (let i = 0; i < 50 && (await handedOff()) === 0; i++) {
        await reapStuckRuns(db, boss, { now: new Date(), staleAfterMs: 10 * 60_000 });
        if ((await handedOff()) === 0) await new Promise((res) => setTimeout(res, 50));
      }
      expect(await handedOff()).toBe(1);
      expect(await runState(r.runId)).toBe("failed");
      expect(r.world.refunds.filter((x) => x.charge === "ch_fixture_001")).toHaveLength(1);
    }, 60_000);

    it("an expired grant keeps a run retryable while its unreceipted send can't be read (#121)", async () => {
      const r = await approvedRun();
      const spy = failSettle("refund_001");
      try {
        await expect(
          handleApplyJob(jobOf(r), contextFor(r.world), { retryCount: 0, retryLimit: 50 }),
        ).rejects.toBeInstanceOf(RetryLater);
      } finally {
        spy.mockRestore();
      }
      const effects = r.world.effects.length;
      const ctx = expired(r.world);
      const stripe = r.world.provider("stripe");
      const unreadable: WorkerContext = {
        ...ctx,
        providers: {
          ...ctx.providers,
          stripe: {
            ...stripe,
            reconcile: async () => {
              throw new Error("stripe read unavailable (injected)");
            },
          },
        },
      };
      // Even on the last try: the reaper re-enqueues it, bounded, then hands it to an operator.
      await expect(
        handleApplyJob(jobOf(r), unreadable, { retryCount: 50, retryLimit: 50 }),
      ).rejects.toBeInstanceOf(RetryLater);
      expect(await runState(r.runId)).toBe("applying");
      expect(r.world.effects.length).toBe(effects);

      // Once the read works, the refund is recorded and the refusal stands.
      const after = await handleApplyJob(jobOf(r), ctx, { retryCount: 0, retryLimit: 50 });
      expect(stateOf(after)).toBe("failed");
      expect(await refundReceipt(r.orgId)).toContain("confirmed");
      expect(r.world.effects.length).toBe(effects);
    });
  },
);
