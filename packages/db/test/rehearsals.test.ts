import { randomBytes, randomUUID } from "node:crypto";
import type { ExecutionRehearsalReport } from "@rehearsal/contracts";
import { planHash, rehearsalOperationKey, snapshotDigest } from "@rehearsal/core";
import { happyPathBundle, rehearsalReportFixture } from "@rehearsal/testkit";
import { and, eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APPLY_QUEUE,
  createDb,
  listRehearsalStepResults,
  loadRehearsal,
  markRehearsalTornDown,
  migrateDb,
  PgApplyStore,
  PgJournal,
  REHEARSAL_QUEUE,
  recordRehearsalStepResult,
  rehearsalReportsFor,
  requestRehearsal,
  saveRehearsalReport,
  schema,
  startQueue,
  transitionRehearsal,
} from "../src";

const NOW = new Date("2026-10-25T09:00:00.000Z");
const newId = () => randomBytes(8).toString("hex");

// Needs a real Postgres: `pnpm infra:up` then `DB_TESTS=1 pnpm --filter @rehearsal/db test`.
describe.skipIf(!process.env.DB_TESTS)("execution rehearsal storage (T3.13, real Postgres)", () => {
  const url = process.env.DATABASE_URL ?? "postgres://rehearsal:rehearsal@localhost:5432/rehearsal";
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

  /** A stored plan revision in a fresh org. */
  async function storedPlan() {
    const orgId = `org_${randomUUID()}`;
    const planId = `plan_${randomUUID()}`;
    const manifest = { ...happyPathBundle().manifest, orgId, planId };
    const hash = planHash(manifest);
    await db
      .insert(schema.planVersions)
      .values({ orgId, planId, revision: 1, planHash: hash, manifest });
    const request = {
      planId,
      revision: 1,
      planHash: hash,
      scenario: { id: "clean" as const, version: 1 },
    };
    return { orgId, planId, hash, manifest, request };
  }
  const ask = (p: Awaited<ReturnType<typeof storedPlan>>, key = randomUUID(), over = {}) =>
    requestRehearsal(db, boss, {
      orgId: p.orgId,
      userId: "user_support",
      idempotencyKey: key,
      request: { ...p.request, ...over },
      now: NOW,
      newId,
    });
  const jobsFor = async (queue: string, rehearsalId: string) =>
    (
      await db.execute(
        sql`select 1 from pgboss.job where name = ${queue} and data->>'rehearsalId' = ${rehearsalId}`,
      )
    ).rows.length;
  const accepted = (r: Awaited<ReturnType<typeof ask>>) => {
    if (r.kind !== "accepted") throw new Error(`not accepted: ${r.kind}`);
    return r.rehearsalId;
  };

  it("stores the request bound to the stored plan and enqueues one job on its own queue", async () => {
    const p = await storedPlan();
    const id = accepted(await ask(p));
    const stored = await loadRehearsal(db, p.orgId, id);
    expect(stored).toMatchObject({
      state: "queued",
      tornDown: false,
      rehearsal: {
        planId: p.planId,
        revision: 1,
        planHash: p.hash,
        scenarioId: "clean",
        scenarioVersion: 1,
        // From the stored manifest, never the caller.
        snapshotDigest: snapshotDigest(p.manifest),
        policyId: p.manifest.policies[0]?.id,
        requestedBy: "user_support",
      },
    });
    expect(await jobsFor(REHEARSAL_QUEUE, id)).toBe(1);
    expect(await jobsFor(APPLY_QUEUE, id)).toBe(0);
  });

  it("returns the same rehearsal for a repeated key and refuses the key for another request", async () => {
    const p = await storedPlan();
    const key = randomUUID();
    const id = accepted(await ask(p, key));
    expect(await ask(p, key)).toEqual({ kind: "accepted", rehearsalId: id, existing: true });
    expect(await ask(p, key, { scenario: { id: "phantom_membership", version: 1 } })).toEqual({
      kind: "idempotency_conflict",
      rehearsalId: id,
    });
    expect(await jobsFor(REHEARSAL_QUEUE, id)).toBe(1);
  });

  it("forks no second rehearsal when the same request arrives concurrently", async () => {
    const p = await storedPlan();
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 6 }, () => ask(p, key)));
    const ids = new Set(results.map(accepted));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.kind === "accepted" && !r.existing)).toHaveLength(1);
    const rows = await db
      .select()
      .from(schema.rehearsals)
      .where(eq(schema.rehearsals.orgId, p.orgId));
    expect(rows).toHaveLength(1);
    expect(await jobsFor(REHEARSAL_QUEUE, [...ids][0] as string)).toBe(1);
  });

  it("refuses an unknown revision, a changed hash and another org's plan", async () => {
    const p = await storedPlan();
    expect(await ask(p, randomUUID(), { revision: 2 })).toEqual({ kind: "not_found" });
    expect((await ask(p, randomUUID(), { planHash: "f".repeat(64) })).kind).toBe("hash_mismatch");
    const other = await storedPlan();
    const foreign = await requestRehearsal(db, boss, {
      orgId: other.orgId,
      userId: "u",
      idempotencyKey: randomUUID(),
      request: p.request,
      now: NOW,
      newId,
    });
    expect(foreign).toEqual({ kind: "not_found" });
  });

  it("never shows a rehearsal to another org", async () => {
    const p = await storedPlan();
    const id = accepted(await ask(p));
    expect(await loadRehearsal(db, `org_${randomUUID()}`, id)).toBeNull();
    expect(
      await transitionRehearsal(db, `org_${randomUUID()}`, id, ["queued"], "provisioning", {
        now: NOW,
      }),
    ).toBe(false);
    expect((await loadRehearsal(db, p.orgId, id))?.state).toBe("queued");
  });

  it("leaves nothing behind when enqueueing fails after the rows were written", async () => {
    const p = await storedPlan();
    const crashing = {
      send: async () => {
        throw new Error("queue unavailable (injected)");
      },
    } as unknown as PgBoss;
    const key = randomUUID();
    await expect(
      requestRehearsal(db, crashing, {
        orgId: p.orgId,
        userId: "u",
        idempotencyKey: key,
        request: p.request,
        now: NOW,
        newId,
      }),
    ).rejects.toThrow(/queue unavailable/);
    expect(
      await db.select().from(schema.rehearsals).where(eq(schema.rehearsals.orgId, p.orgId)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.rehearsalEvents)
        .where(eq(schema.rehearsalEvents.orgId, p.orgId)),
    ).toEqual([]);
    // The same key then works: the failed attempt reserved nothing.
    expect((await ask(p, key)).kind).toBe("accepted");
  });

  it("lets exactly one delivery claim a rehearsal, and keeps terminal states final", async () => {
    const p = await storedPlan();
    const id = accepted(await ask(p));
    const claims = await Promise.all(
      Array.from({ length: 5 }, () =>
        transitionRehearsal(db, p.orgId, id, ["queued"], "provisioning", { now: NOW }),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    // Illegal moves are refused.
    expect(
      await transitionRehearsal(db, p.orgId, id, ["provisioning"], "completed", { now: NOW }),
    ).toBe(false);
    for (const to of ["running", "verifying", "completed"] as const) {
      const from = (await loadRehearsal(db, p.orgId, id))?.state;
      expect(await transitionRehearsal(db, p.orgId, id, [from ?? "queued"], to, { now: NOW })).toBe(
        true,
      );
    }
    expect(await transitionRehearsal(db, p.orgId, id, ["completed"], "failed", { now: NOW })).toBe(
      false,
    );
    expect(await markRehearsalTornDown(db, p.orgId, id, NOW)).toBe(true);
    expect(await markRehearsalTornDown(db, p.orgId, id, NOW)).toBe(false);
    const stored = await loadRehearsal(db, p.orgId, id);
    expect(stored?.state).toBe("completed");
    expect(stored?.tornDown).toBe(true);
    expect(stored?.events.map((e) => e.state)).toEqual([
      "queued",
      "provisioning",
      "running",
      "verifying",
      "completed",
      "completed",
    ]);
  });

  it("can't be torn down before it ends", async () => {
    const p = await storedPlan();
    const id = accepted(await ask(p));
    expect(await markRehearsalTornDown(db, p.orgId, id, NOW)).toBe(false);
  });

  it("keeps rehearsal journal rows out of operational adoption, admission and approval lookup", async () => {
    const p = await storedPlan();
    const id = accepted(await ask(p));
    const action = p.manifest.actions[0];
    if (!action) throw new Error("no action");
    const opKey = `op_${randomUUID()}`;
    const attempt = {
      id: `att_${randomUUID()}`,
      orgId: p.orgId,
      rehearsalId: id,
      planHash: p.hash,
      actionId: action.id,
      attemptNo: 1,
      state: "confirmed",
      request: {
        method: "POST",
        path: "/v1/refunds",
        encoding: "form",
        body: "",
        bodySha256: "b".repeat(64),
      },
      preparedAt: NOW,
    };
    // An un-namespaced key is refused by the table itself.
    await expect(
      db.insert(schema.rehearsalAttempts).values({ ...attempt, operationKey: opKey }),
    ).rejects.toThrow();
    await db
      .insert(schema.rehearsalAttempts)
      .values({ ...attempt, operationKey: rehearsalOperationKey(id, opKey) });

    // The operational journal, run store and grant lookup see none of it.
    const journal = new PgJournal(db, p.orgId);
    expect(await journal.attemptsForKey(opKey)).toEqual([]);
    expect(await journal.attemptsForKey(rehearsalOperationKey(id, opKey))).toEqual([]);
    expect(await journal.attemptsFor(p.hash, action.id)).toEqual([]);
    expect(await journal.receiptsFor(p.hash)).toEqual([]);
    const store = new PgApplyStore(db);
    expect(await store.loadRun(p.orgId, id)).toBeNull();
    expect(await store.loadGrant(p.orgId, id)).toBeNull();
  });

  it("stores step results only for this rehearsal, its hash and its key namespace", async () => {
    const p = await storedPlan();
    const id = accepted(await ask(p));
    const base = {
      world: "rehearsal" as const,
      rehearsalId: id,
      actionId: "refund_001",
      planHash: p.hash,
      operationKey: rehearsalOperationKey(id, "op_x"),
      outcome: "confirmed" as const,
      providerRef: null,
      observedEffect: { "refund.id": "re_1" },
      holdReason: null,
      limitations: [],
      recordedAt: NOW.toISOString(),
    };
    await recordRehearsalStepResult(db, p.orgId, base, `rsr_${randomUUID()}`);
    expect(await listRehearsalStepResults(db, p.orgId, id)).toEqual([base]);
    await expect(
      recordRehearsalStepResult(
        db,
        p.orgId,
        { ...base, planHash: "c".repeat(64) },
        `rsr_${randomUUID()}`,
      ),
    ).rejects.toThrow(/another plan hash/);
    await expect(
      recordRehearsalStepResult(
        db,
        p.orgId,
        { ...base, operationKey: rehearsalOperationKey("othersrehearsal", "op_x") },
        `rsr_${randomUUID()}`,
      ),
    ).rejects.toThrow(/not namespaced/);
    await expect(
      recordRehearsalStepResult(db, `org_${randomUUID()}`, base, `rsr_${randomUUID()}`),
    ).rejects.toThrow(/no rehearsal/);
  });

  /** The fixture report, re-pointed at this rehearsal and plan. */
  async function reportFor(p: Awaited<ReturnType<typeof storedPlan>>, id: string) {
    const stored = await loadRehearsal(db, p.orgId, id);
    if (!stored) throw new Error("no rehearsal");
    const fixture = rehearsalReportFixture("passed");
    const report: ExecutionRehearsalReport = {
      ...fixture,
      rehearsalId: id,
      plan: { orgId: p.orgId, planId: p.planId, revision: 1, planHash: p.hash },
      snapshot: { kind: "plan-evidence", digest: stored.rehearsal.snapshotDigest },
      policy: { id: stored.rehearsal.policyId, version: stored.rehearsal.policyVersion },
      steps: fixture.steps.map((s) => ({
        ...s,
        result: s.result && {
          ...s.result,
          rehearsalId: id,
          planHash: p.hash,
          operationKey: rehearsalOperationKey(id, `op_${s.actionId}`),
        },
      })),
    };
    return report;
  }
  async function complete(p: Awaited<ReturnType<typeof storedPlan>>, id: string) {
    for (const [from, to] of [
      ["queued", "provisioning"],
      ["provisioning", "running"],
      ["running", "verifying"],
      ["verifying", "completed"],
    ] as const) {
      expect(await transitionRehearsal(db, p.orgId, id, [from], to, { now: NOW })).toBe(true);
    }
  }

  it("keeps one immutable report per ended rehearsal, and every report of a plan", async () => {
    const p = await storedPlan();
    const first = accepted(await ask(p));
    const early = await reportFor(p, first);
    await expect(saveRehearsalReport(db, p.orgId, early, NOW)).rejects.toThrow(
      /the rehearsal is queued/,
    );
    await complete(p, first);
    await saveRehearsalReport(db, p.orgId, await reportFor(p, first), NOW);
    await expect(saveRehearsalReport(db, p.orgId, await reportFor(p, first), NOW)).rejects.toThrow(
      /already has a report/,
    );
    const wrongPlan = { ...(await reportFor(p, first)), plan: { ...early.plan, revision: 2 } };
    await expect(saveRehearsalReport(db, p.orgId, wrongPlan, NOW)).rejects.toThrow(/doesn't match/);

    // A later rehearsal of the same plan adds a report; the earlier one is kept.
    const second = accepted(await ask(p));
    await complete(p, second);
    await saveRehearsalReport(
      db,
      p.orgId,
      await reportFor(p, second),
      new Date(NOW.getTime() + 60_000),
    );
    expect((await rehearsalReportsFor(db, p.orgId, p.planId)).map((r) => r.rehearsalId)).toEqual([
      second,
      first,
    ]);
    expect(await rehearsalReportsFor(db, `org_${randomUUID()}`, p.planId)).toEqual([]);
    const rows = await db
      .select()
      .from(schema.rehearsalReports)
      .where(
        and(
          eq(schema.rehearsalReports.orgId, p.orgId),
          eq(schema.rehearsalReports.planId, p.planId),
        ),
      );
    expect(rows).toHaveLength(2);
  });
});
