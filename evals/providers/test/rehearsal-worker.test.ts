import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { PlanManifest } from "@rehearsal/contracts";
import { type BillingPolicy, planHash } from "@rehearsal/core";
import {
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
  REHEARSAL_PROVISION_ROUTE,
  REHEARSAL_TEARDOWN_ROUTE,
  REHEARSAL_TENANT_TOKEN_ROUTE,
  REHEARSAL_URL_KEYS,
  rehearsalOperatorPath,
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

    async function requested(manifest: PlanManifest) {
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
          scenario: { id: "clean", version: 1 },
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
      expect(report).toMatchObject({ rehearsalId: id, state: "completed" });
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
  },
);
