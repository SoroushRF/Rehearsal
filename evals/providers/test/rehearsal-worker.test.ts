import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type {
  ExecutionRehearsalReport,
  PlanManifest,
  RehearsalScenarioId,
} from "@rehearsal/contracts";
import { type BillingPolicy, planHash, VERIFIER_VERSION } from "@rehearsal/core";
import {
  cancelRehearsal,
  createDb,
  listRehearsalStepResults,
  loadRehearsal,
  migrateDb,
  type PgBoss,
  rehearsalReportsFor,
  requestRehearsal,
  runRehearsalJob,
  schema,
  startQueue,
} from "@rehearsal/db";
import {
  eraFetch,
  REHEARSAL_PROVISION_ROUTE,
  REHEARSAL_TEARDOWN_ROUTE,
  REHEARSAL_TENANT_TOKEN_ROUTE,
  REHEARSAL_URL_KEYS,
  rehearsalOperatorPath,
  rehearsalWorkerWorlds,
} from "@rehearsal/providers";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../../apps/api/src/app";
import { rehearsalTenantActive } from "../../../apps/api/src/rehearsal-operator";
import {
  type RehearsalWorkerConfig,
  rehearsalWorkerConfigViolations,
  runContext,
  workerVersions,
} from "../../../apps/rehearsal-worker/src/worker";
import policy from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import policyV3 from "../../../scenarios/billing/policy.v3.json" with { type: "json" };
import { REHEARSAL_ENABLED } from "../src/harness";
import { manifestFor } from "../src/rehearsal-plan";

const POLICIES = [policy, policyV3] as unknown as BillingPolicy[];

// T3.16 on Era: the rehearsal worker's context against the API's real operator and mint routes.
// The worker holds only its secret and the rehearsal URLs; the API provisions, mints and resets.
// Needs `pnpm infra:up:rehearsal`, Postgres, and `ERA_CONFORMANCE=1 ERA_REHEARSAL=1 DB_TESTS=1`
// with REHEARSAL_ERA_ADMIN_TOKEN and REHEARSAL_WORKER_SECRET set (see .env.example).
describe.skipIf(!REHEARSAL_ENABLED || !process.env.DB_TESTS)(
  "rehearsal worker through the operator routes (T3.16)",
  () => {
    const url =
      process.env.DATABASE_URL ?? "postgres://rehearsal:rehearsal@localhost:5432/rehearsal";
    const secret = process.env.REHEARSAL_WORKER_SECRET ?? "";
    const adminToken = process.env.REHEARSAL_ERA_ADMIN_TOKEN ?? "";
    const db = createDb(url);
    let boss: PgBoss;
    let api: ReturnType<typeof buildApp>;
    let apiUrl = "";
    beforeAll(async () => {
      await migrateDb(db);
      boss = await startQueue(url);
      api = buildApp({
        webRoot: null,
        rehearsalTokens: {
          adminToken,
          secret,
          active: (id) => rehearsalTenantActive(db, id),
          env: process.env,
        },
        rehearsalOperator: { db, secret },
      });
      await api.listen({ port: 0, host: "127.0.0.1" });
      apiUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      await api?.close();
      await boss?.stop({ graceful: false });
      await db.$client.end();
    });

    /** Only what decision 0013 gives the rehearsal worker: its secret, the API and its worlds. */
    function workerEnv(): NodeJS.ProcessEnv {
      const env: NodeJS.ProcessEnv = {
        REHEARSAL_API_URL: apiUrl,
        REHEARSAL_WORKER_SECRET: secret,
        DATABASE_URL: url,
      };
      for (const key of Object.values(REHEARSAL_URL_KEYS)) env[key] = process.env[key];
      return env;
    }
    function config(): RehearsalWorkerConfig {
      const env = workerEnv();
      return {
        db,
        env,
        clock: { now: () => new Date() },
        policies: POLICIES,
        newId: (p) => `${p}_${randomUUID()}`,
        versions: workerVersions(env),
        evidence: "era_integration",
      };
    }

    async function requested(manifest: PlanManifest, scenario: RehearsalScenarioId = "clean") {
      const hash = planHash(manifest);
      await db.insert(schema.planVersions).values({
        orgId: manifest.orgId,
        planId: manifest.planId,
        revision: manifest.revision,
        planHash: hash,
        manifest,
      });
      const res = await requestRehearsal(db, boss, {
        orgId: manifest.orgId,
        userId: "user_support",
        idempotencyKey: randomUUID(),
        request: {
          planId: manifest.planId,
          revision: manifest.revision,
          planHash: hash,
          scenario: { id: scenario, version: 1 },
        },
        now: new Date(),
        newId: () => randomBytes(8).toString("hex"),
      });
      if (res.kind !== "accepted") throw new Error(`not accepted: ${res.kind}`);
      const [job] = (
        await db.execute<{ data: unknown }>(
          sql`select data from pgboss.job where name = 'rehearsal' and data->>'rehearsalId' = ${res.rehearsalId}`,
        )
      ).rows;
      return { id: res.rehearsalId, data: job?.data };
    }

    const post = (path: string, body?: unknown, bearer = secret) =>
      fetch(`${apiUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

    it("starts only with its own credentials", () => {
      expect(rehearsalWorkerConfigViolations(workerEnv())).toEqual([]);
      expect(
        rehearsalWorkerConfigViolations({ ...workerEnv(), REHEARSAL_ERA_ADMIN_TOKEN: "x" }),
      ).toContain("must not hold REHEARSAL_ERA_ADMIN_TOKEN");
    });

    it("runs a requested rehearsal end to end: provisioned, run, reported and reset", async () => {
      const manifest = manifestFor(`org_${randomUUID()}`, `plan_${randomUUID()}`);
      const { id, data } = await requested(manifest);

      // Queued: nothing to mint, provision or reset yet; and only the worker's secret works.
      const mint = { vendor: "stripe", rehearsalId: id };
      expect((await post(REHEARSAL_TENANT_TOKEN_ROUTE, mint)).status).toBe(409);
      expect((await post(rehearsalOperatorPath(REHEARSAL_PROVISION_ROUTE, id))).status).toBe(409);
      expect((await post(rehearsalOperatorPath(REHEARSAL_TEARDOWN_ROUTE, id))).status).toBe(409);
      expect(
        (await post(rehearsalOperatorPath(REHEARSAL_PROVISION_ROUTE, id), undefined, "nope"))
          .status,
      ).toBe(401);

      const result = await runRehearsalJob(data, runContext(id, config()));
      expect(result).toMatchObject({ kind: "ran", state: "completed" });
      const results = await listRehearsalStepResults(db, manifest.orgId, id);
      expect(results.map((r) => [r.actionId, r.outcome]).sort()).toEqual([
        ["note_001", "confirmed"],
        ["patch_001", "confirmed"],
        ["refund_001", "confirmed"],
      ]);
      const [report] = await rehearsalReportsFor(db, manifest.orgId, manifest.planId);
      expect(report).toMatchObject({ rehearsalId: id, state: "completed", verdict: "passed" });
      expectMatched(report);
      const stored = await loadRehearsal(db, manifest.orgId, id);
      expect(stored?.tornDown).toBe(true);
      // Reset: the operator mints nothing more for it.
      expect((await post(REHEARSAL_TENANT_TOKEN_ROUTE, mint)).status).toBe(409);

      const attempts = await db
        .select()
        .from(schema.rehearsalAttempts)
        .where(
          and(
            eq(schema.rehearsalAttempts.orgId, manifest.orgId),
            eq(schema.rehearsalAttempts.rehearsalId, id),
          ),
        );
      expect(attempts.map((a) => a.state).sort()).toEqual(["confirmed", "confirmed", "confirmed"]);
      for (const table of [schema.stepAttempts, schema.stepReceipts, schema.objectBindings]) {
        expect(await db.select().from(table).where(eq(table.orgId, manifest.orgId))).toEqual([]);
      }
    }, 90_000);

    /** Every step was judged from reads of the tenant (T4.12), not from the receipts. */
    function expectMatched(report: ExecutionRehearsalReport | undefined) {
      expect(report?.versions.verifier).toBe(VERIFIER_VERSION);
      expect(report?.steps.map((x) => [x.actionId, x.verification.status]).sort()).toEqual(
        report?.steps.map((x) => [x.actionId, "matched"]).sort(),
      );
    }

    /** Refunds of one charge in this rehearsal's own Stripe tenant, read just before teardown. */
    function countingRefunds(id: string, chargeId: string) {
      const ctx = runContext(id, config());
      const seen: number[] = [];
      const teardown = ctx.teardown;
      ctx.teardown = async (rid, state) => {
        const world = rehearsalWorkerWorlds(rid, workerEnv()).stripe;
        const res = await eraFetch(
          world,
          `/v1/refunds?charge=${encodeURIComponent(chargeId)}&limit=100`,
          { headers: { authorization: "Bearer sk_test_rehearsal_check" } },
        );
        const body = (await res.json()) as { data: unknown[] };
        seen.push(body.data.length);
        await teardown(rid, state);
      };
      return { ctx, seen };
    }

    it("phantom_membership on Era: the operator injects, the guard holds the refund, no refund lands", async () => {
      const manifest = manifestFor(`org_${randomUUID()}`, `plan_${randomUUID()}`);
      const { id, data } = await requested(manifest, "phantom_membership");
      const result = await runRehearsalJob(data, runContext(id, config()));
      expect(result).toMatchObject({ kind: "ran", state: "completed" });
      const report = result.kind === "ran" ? result.report : null;
      if (!report) throw new Error("no report");
      for (const step of report.steps) {
        expect({ step: step.actionId, got: step.result?.outcome }).toEqual({
          step: step.actionId,
          got: step.expected,
        });
      }
      const refund = report.steps.find((x) => x.actionId === "refund_001");
      expect(refund?.result?.holdReason?.kind).toBe("query_membership_changed");
      expect(report.verdict).toBe("passed");
      expectMatched(report);
      const attempts = await db
        .select()
        .from(schema.rehearsalAttempts)
        .where(eq(schema.rehearsalAttempts.rehearsalId, id));
      expect(attempts.some((a) => a.actionId === "refund_001")).toBe(false);
      const [mark] = await db
        .select()
        .from(schema.rehearsalDirtyMarks)
        .where(eq(schema.rehearsalDirtyMarks.rehearsalId, id));
      expect(mark?.clearedAt).not.toBeNull();
      expect((await loadRehearsal(db, manifest.orgId, id))?.tornDown).toBe(true);
      for (const table of [schema.stepAttempts, schema.stepReceipts, schema.objectBindings]) {
        expect(await db.select().from(table).where(eq(table.orgId, manifest.orgId))).toEqual([]);
      }
    }, 90_000);

    for (const scenario of ["teammate_field_edit", "benign_nonmatching_change"] as const) {
      it(`${scenario} on Era: every step ends as the catalog expects and reads back matched`, async () => {
        const manifest = manifestFor(`org_${randomUUID()}`, `plan_${randomUUID()}`);
        const { id, data } = await requested(manifest, scenario);
        const result = await runRehearsalJob(data, runContext(id, config()));
        const report = result.kind === "ran" ? result.report : null;
        if (!report) throw new Error(`no report: ${JSON.stringify(result)}`);
        for (const step of report.steps) {
          expect({ step: step.actionId, got: step.result?.outcome }).toEqual({
            step: step.actionId,
            got: step.expected,
          });
        }
        expect(report.verdict).toBe("passed");
        expectMatched(report);
        expect((await loadRehearsal(db, manifest.orgId, id))?.tornDown).toBe(true);
      }, 90_000);
    }

    it("cancelled mid-run on Era: what was sent is read back, nothing new is sent, the report says so", async () => {
      const manifest = manifestFor(`org_${randomUUID()}`, `plan_${randomUUID()}`);
      const { id, data } = await requested(manifest);
      const ctx = runContext(id, config());
      const stripe = ctx.providers.stripe;
      if (!stripe) throw new Error("no stripe provider");
      const sent: string[] = [];
      // A reviewer cancels the moment the first write has gone out.
      ctx.providers.stripe = {
        ...stripe,
        dispatch: async (req, world) => {
          const res = await stripe.dispatch(req, world);
          sent.push(`stripe ${req.method} ${req.path}`);
          await cancelRehearsal(db, manifest.orgId, id, { now: new Date() });
          return res;
        },
      };
      const zendesk = ctx.providers.zendesk;
      if (!zendesk) throw new Error("no zendesk provider");
      ctx.providers.zendesk = {
        ...zendesk,
        dispatch: async (req, world) => {
          sent.push(`zendesk ${req.method} ${req.path}`);
          return zendesk.dispatch(req, world);
        },
      };
      const result = await runRehearsalJob(data, ctx);
      expect(result).toMatchObject({ kind: "ran", state: "cancelled" });
      const report = result.kind === "ran" ? result.report : null;
      if (!report) throw new Error("no report");
      // The refund went out; the ticket patch and the note never did.
      expect(sent).toEqual(["stripe POST /v1/refunds"]);
      const steps = Object.fromEntries(report.steps.map((x) => [x.actionId, x]));
      expect(steps.refund_001?.result?.outcome).toBe("confirmed");
      expect(steps.refund_001?.verification.status).toBe("matched");
      expect(steps.patch_001?.result).toBeNull();
      expect(steps.note_001?.result).toBeNull();
      expect(report.state).toBe("cancelled");
      expect(report.verdict).not.toBe("passed");
      expect((await loadRehearsal(db, manifest.orgId, id))?.tornDown).toBe(true);
    }, 90_000);

    it("lost_response_restart on Era: the refund commits once, the restart reads it back", async () => {
      const manifest = manifestFor(`org_${randomUUID()}`, `plan_${randomUUID()}`);
      const { id, data } = await requested(manifest, "lost_response_restart");
      const refund = manifest.actions.find((a) => a.id === "refund_001");
      const chargeId = refund?.kind === "stripe.refund.create" ? refund.args.chargeId : "";
      const { ctx, seen } = countingRefunds(id, chargeId);
      const result = await runRehearsalJob(data, ctx);
      expect(result).toMatchObject({ kind: "ran", state: "completed" });
      const report = result.kind === "ran" ? result.report : null;
      if (!report) throw new Error("no report");
      // Exactly one refund in the tenant, read from Stripe itself before it was reset.
      expect(seen).toEqual([1]);
      expect(report.steps.map((x) => [x.actionId, x.result?.outcome]).sort()).toEqual([
        ["note_001", "confirmed"],
        ["patch_001", "confirmed"],
        ["refund_001", "confirmed"],
      ]);
      const refundAttempts = (
        await db
          .select()
          .from(schema.rehearsalAttempts)
          .where(eq(schema.rehearsalAttempts.rehearsalId, id))
      ).filter((a) => a.actionId === "refund_001");
      // One attempt, sent once; the restart settled it by reading Stripe.
      expect(refundAttempts.map((a) => a.state)).toEqual(["reconciled"]);
      const refundStep = report.steps.find((x) => x.actionId === "refund_001");
      expect(refundStep?.result?.providerRef).toMatchObject({ vendor: "stripe", kind: "refund" });
      expect(report.verdict).toBe("passed");
      expectMatched(report);
      expect((await loadRehearsal(db, manifest.orgId, id))?.tornDown).toBe(true);
    }, 90_000);
  },
);
