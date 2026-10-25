import { randomBytes, randomUUID } from "node:crypto";
import type { PlanManifest } from "@rehearsal/contracts";
import { type BillingPolicy, type ProviderPort, planHash, rehearsalTenant } from "@rehearsal/core";
import {
  FakeClock,
  type FakeWorld,
  FIXTURE_REHEARSAL_VERSIONS,
  happyPathBundle,
  worldFromManifest,
} from "@rehearsal/testkit";
import { and, eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import policy from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import policyV3 from "../../../scenarios/billing/policy.v3.json" with { type: "json" };
import {
  cancelRehearsal,
  createDb,
  HAND_OFF,
  IN_FLIGHT_KEPT,
  loadRehearsal,
  migrateDb,
  type RehearsalRunContext,
  type RehearsalSweepContext,
  rehearsalReportsFor,
  requestRehearsal,
  runRehearsalJob,
  schema,
  startQueue,
  sweepRehearsals,
  transitionRehearsal,
} from "../src";

const POLICIES = [policy, policyV3] as unknown as BillingPolicy[];
const START = "2026-10-01T12:00:00.000Z";
const LEASE = 10 * 60_000;
const HAND_OFF_AFTER = 60 * 60_000;
const at = (ms: number) => new Date(Date.parse(START) + ms);

// Needs a real Postgres: `pnpm infra:up` then `DB_TESTS=1 pnpm --filter @rehearsal/db test`.
// The worlds are in-memory fakes (evidence `fixture`); the store, journal and queue are real.
describe.skipIf(!process.env.DB_TESTS)(
  "rehearsal restart, cancellation and cleanup (T3.16)",
  () => {
    const url =
      process.env.DATABASE_URL ?? "postgres://rehearsal:rehearsal@localhost:5432/rehearsal";
    const db = createDb(url);
    // Workers run on their own pool: a "dead" one never gives its connection (and the container
    // set lock on it) back, which a crashed process does only by dying. Its close isn't awaited.
    const workerDb = createDb(url);
    let boss: PgBoss;
    beforeAll(async () => {
      await migrateDb(db);
      boss = await startQueue(url);
    });
    afterAll(async () => {
      await boss?.stop({ graceful: false });
      await db.$client.end();
      void workerDb.$client.end().catch(() => {});
    });

    /** A stored plan in a fresh org, a queued rehearsal of it, and its job payload. */
    async function requested() {
      const orgId = `org_${randomUUID()}`;
      const planId = `plan_${randomUUID()}`;
      const manifest: PlanManifest = { ...happyPathBundle().manifest, orgId, planId };
      const hash = planHash(manifest);
      await db
        .insert(schema.planVersions)
        .values({ orgId, planId, revision: 1, planHash: hash, manifest });
      const res = await requestRehearsal(db, boss, {
        orgId,
        userId: "user_support",
        idempotencyKey: randomUUID(),
        request: { planId, revision: 1, planHash: hash, scenario: { id: "clean", version: 1 } },
        now: at(0),
        newId: () => randomBytes(8).toString("hex"),
      });
      if (res.kind !== "accepted") throw new Error(`not accepted: ${res.kind}`);
      const [job] = (
        await db.execute<{ data: unknown }>(
          sql`select data from pgboss.job where name = 'rehearsal' and data->>'rehearsalId' = ${res.rehearsalId}`,
        )
      ).rows;
      return { orgId, planId, manifest, id: res.rehearsalId, data: job?.data };
    }

    /** A worker's context over one fake world, with a hook before every send. */
    function worker(
      id: string,
      world: FakeWorld,
      beforeSend: (vendor: "stripe" | "zendesk") => Promise<"send" | "die"> = async () => "send",
    ) {
      const torn: string[] = [];
      const wrap = (vendor: "stripe" | "zendesk"): ProviderPort => {
        const inner = world.provider(vendor);
        return {
          ...inner,
          dispatch: async (request, ctx) => {
            const next = await beforeSend(vendor);
            const result = await inner.dispatch(request, ctx);
            // The worker dies with the request committed: no response, no receipt, ever.
            if (next === "die") await new Promise(() => {});
            return result;
          },
        };
      };
      const tenant = rehearsalTenant(id);
      const ctx: RehearsalRunContext = {
        db: workerDb,
        // Its own set, so a dead worker's shared hold never makes another file's challenge wait.
        containerSet: `set_${randomUUID()}`,
        providers: { stripe: wrap("stripe"), zendesk: wrap("zendesk") },
        worlds: { stripe: { world: "rehearsal", tenant }, zendesk: { world: "rehearsal", tenant } },
        clock: new FakeClock(START),
        policies: POLICIES,
        newId: (p) => `${p}_${randomUUID()}`,
        versions: FIXTURE_REHEARSAL_VERSIONS,
        evidence: "fixture",
        provision: async () => ({ ok: true, notFromEvidence: [] }),
        teardown: async (rid) => {
          torn.push(rid);
        },
        sleep: async () => {},
      };
      return { ctx, torn };
    }

    /** A sweeper for one org, reading through `readers` (the dead worker's world by default). */
    function sweeper(orgId: string, world: FakeWorld | null, now: Date) {
      const torn: string[] = [];
      const handedOff: string[][] = [];
      const ctx: RehearsalSweepContext = {
        db,
        now,
        leaseMs: LEASE,
        handOffAfterMs: HAND_OFF_AFTER,
        orgIds: [orgId],
        readers: async (rid) =>
          world && {
            providers: { stripe: world.provider("stripe"), zendesk: world.provider("zendesk") },
            worlds: {
              stripe: { world: "rehearsal", tenant: rehearsalTenant(rid) },
              zendesk: { world: "rehearsal", tenant: rehearsalTenant(rid) },
            },
          },
        teardown: async (rid) => {
          torn.push(rid);
        },
        onHandOff: (ids) => handedOff.push(ids),
        clock: new FakeClock(now.toISOString()),
        policies: POLICIES,
        newId: (p) => `${p}_${randomUUID()}`,
        versions: FIXTURE_REHEARSAL_VERSIONS,
        evidence: "fixture",
      };
      return { run: () => sweepRehearsals(ctx), torn, handedOff };
    }

    const attempts = (orgId: string, id: string) =>
      db
        .select()
        .from(schema.rehearsalAttempts)
        .where(
          and(
            eq(schema.rehearsalAttempts.orgId, orgId),
            eq(schema.rehearsalAttempts.rehearsalId, id),
          ),
        );

    async function untilDispatched(orgId: string, id: string) {
      for (let i = 0; i < 200; i++) {
        if ((await attempts(orgId, id)).some((a) => a.state === "dispatched")) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("no attempt was dispatched");
    }

    async function operationalUntouched(orgId: string) {
      for (const table of [schema.stepAttempts, schema.stepReceipts, schema.objectBindings]) {
        expect(await db.select().from(table).where(eq(table.orgId, orgId))).toEqual([]);
      }
      expect(await db.select().from(schema.runs).where(eq(schema.runs.orgId, orgId))).toEqual([]);
    }

    it("a worker that dies after a send: the sweeper fails it, reads the send back, reports and tears down", async () => {
      const r = await requested();
      const world = worldFromManifest(r.manifest.observations);
      let sends = 0;
      const w = worker(r.id, world, async () => (++sends === 1 ? "die" : "send"));
      void runRehearsalJob(r.data, w.ctx); // never settles: the worker is gone
      await untilDispatched(r.orgId, r.id);
      expect(world.effects).toHaveLength(1);

      // Within the lease nothing happens: it may still be working.
      expect((await sweeper(r.orgId, world, at(LEASE - 1)).run()).expired).toEqual([]);
      // A redelivery of the job never resumes it.
      expect(await runRehearsalJob(r.data, worker(r.id, world).ctx)).toEqual({
        kind: "skipped",
        reason: "rehearsal is running",
      });

      const s = sweeper(r.orgId, world, at(LEASE + 1));
      expect(await s.run()).toMatchObject({ expired: [r.id], tornDown: [r.id], retained: [] });
      expect(s.torn).toEqual([r.id]);
      // Read back, never re-sent: one effect, the attempt confirmed by the read.
      expect(world.effects).toHaveLength(1);
      const rows = await attempts(r.orgId, r.id);
      expect(rows.map((a) => a.state)).toEqual(["reconciled"]);
      const stored = await loadRehearsal(db, r.orgId, r.id);
      expect(stored?.state).toBe("failed");
      expect(stored?.tornDown).toBe(true);
      expect(stored?.events.find((e) => e.state === "failed")?.detail).toMatch(/lease expired/);

      const [report] = await rehearsalReportsFor(db, r.orgId, r.planId);
      expect(report?.state).toBe("failed");
      expect(report?.verdict).toBe("unknown");
      const sent = report?.steps.filter((x) => x.result !== null);
      expect(sent?.map((x) => x.result?.outcome)).toEqual(["confirmed"]);
      expect(report?.limitations.join(" ")).toMatch(/worker stopped before reporting/);
      await operationalUntouched(r.orgId);

      // Done: a later sweep finds nothing to do.
      expect(await sweeper(r.orgId, world, at(LEASE * 3)).run()).toMatchObject({
        expired: [],
        tornDown: [],
      });
    }, 30_000);

    it("a send that can't be read stays in flight: the tenant is kept, then handed to an operator once", async () => {
      const r = await requested();
      const world = worldFromManifest(r.manifest.observations);
      let sends = 0;
      void runRehearsalJob(
        r.data,
        worker(r.id, world, async () => (++sends === 1 ? "die" : "send")).ctx,
      );
      await untilDispatched(r.orgId, r.id);

      // No readers (the operator can't mint the tenant's tokens now): nothing is guessed.
      const first = sweeper(r.orgId, null, at(LEASE + 1));
      expect(await first.run()).toMatchObject({ expired: [r.id], retained: [r.id], tornDown: [] });
      expect(first.torn).toEqual([]);
      expect(first.handedOff).toEqual([]);
      const [report] = await rehearsalReportsFor(db, r.orgId, r.planId);
      expect(report?.limitations).toContain(IN_FLIGHT_KEPT);

      // Past the retention window: handed off once, still kept, never reset.
      const later = sweeper(r.orgId, null, at(LEASE + HAND_OFF_AFTER + 2));
      expect(await later.run()).toMatchObject({ retained: [r.id], handedOff: [r.id] });
      expect(later.handedOff).toEqual([[r.id]]);
      const again = sweeper(r.orgId, null, at(LEASE + 2 * HAND_OFF_AFTER));
      expect(await again.run()).toMatchObject({ retained: [r.id], handedOff: [] });
      expect([...later.torn, ...again.torn]).toEqual([]);
      const stored = await loadRehearsal(db, r.orgId, r.id);
      expect(stored?.events.filter((e) => e.detail?.startsWith(HAND_OFF))).toHaveLength(1);
      expect(stored?.tornDown).toBe(false);
      expect((await attempts(r.orgId, r.id)).map((a) => a.state)).toEqual(["dispatched"]);

      // Once it can be read, the effect is found and the tenant reset.
      const done = sweeper(r.orgId, world, at(LEASE + 3 * HAND_OFF_AFTER));
      expect(await done.run()).toMatchObject({ tornDown: [r.id], retained: [] });
      expect(world.effects).toHaveLength(1);
    }, 30_000);

    it("cancelling mid-run stops fresh sends, reports what happened, then tears down", async () => {
      const r = await requested();
      const world = worldFromManifest(r.manifest.observations);
      let sends = 0;
      const early = sweeper(r.orgId, world, at(2));
      const w = worker(r.id, world, async () => {
        if (++sends === 1) {
          expect(await cancelRehearsal(db, r.orgId, r.id, { now: at(1) })).toBe("cancelled");
          // A sweep while that send is still on the wire leaves it to the live worker.
          expect(await early.run()).toMatchObject({ tornDown: [], retained: [] });
        }
        return "send";
      });
      const result = await runRehearsalJob(r.data, w.ctx);
      expect(result).toMatchObject({ kind: "ran", state: "cancelled" });
      expect(early.torn).toEqual([]);
      // The send already under way finished and was read back; nothing after it was sent.
      expect(world.effects).toHaveLength(1);
      expect((await attempts(r.orgId, r.id)).map((a) => a.state)).toEqual(["confirmed"]);
      const report = result.kind === "ran" ? result.report : null;
      expect(report?.state).toBe("cancelled");
      expect(report?.steps.filter((x) => x.result !== null).map((x) => x.result?.outcome)).toEqual([
        "confirmed",
      ]);
      expect(report?.steps.filter((x) => x.result === null).length).toBeGreaterThan(0);
      expect(await rehearsalReportsFor(db, r.orgId, r.planId)).toEqual([report]);
      expect(w.torn).toEqual([r.id]);
      expect((await loadRehearsal(db, r.orgId, r.id))?.tornDown).toBe(true);
      expect(await cancelRehearsal(db, r.orgId, r.id, { now: at(2) })).toBe("ended");
      await operationalUntouched(r.orgId);
    }, 30_000);

    it("a cancelled queued rehearsal is never claimed, and the sweeper resets its tenant", async () => {
      const r = await requested();
      expect(await cancelRehearsal(db, r.orgId, r.id, { now: at(1) })).toBe("cancelled");
      const world = worldFromManifest(r.manifest.observations);
      expect(await runRehearsalJob(r.data, worker(r.id, world).ctx)).toEqual({
        kind: "skipped",
        reason: "rehearsal is cancelled",
      });
      expect(world.effects).toEqual([]);
      const s = sweeper(r.orgId, world, at(2));
      expect(await s.run()).toMatchObject({ tornDown: [r.id] });
      expect(s.torn).toEqual([r.id]);
    }, 30_000);

    it("a live worker whose lease the sweeper already ended sends nothing more", async () => {
      const r = await requested();
      const world = worldFromManifest(r.manifest.observations);
      let sends = 0;
      const w = worker(r.id, world, async () => {
        if (++sends === 1) {
          // As the sweeper would after an expired lease, while this worker is only slow.
          await transitionRehearsal(db, r.orgId, r.id, ["running"], "failed", {
            now: at(LEASE + 1),
            detail: "lease expired in running",
          });
        }
        return "send";
      });
      const result = await runRehearsalJob(r.data, w.ctx);
      expect(result).toMatchObject({ kind: "ran", state: "failed" });
      expect(world.effects).toHaveLength(1);
      expect((await loadRehearsal(db, r.orgId, r.id))?.state).toBe("failed");
    }, 30_000);

    it("two sweepers at once reset a tenant once", async () => {
      const r = await requested();
      await cancelRehearsal(db, r.orgId, r.id, { now: at(1) });
      const a = sweeper(r.orgId, null, at(2));
      const b = sweeper(r.orgId, null, at(2));
      await Promise.all([a.run(), b.run()]);
      expect([...a.torn, ...b.torn]).toEqual([r.id]);
    }, 30_000);
  },
);
