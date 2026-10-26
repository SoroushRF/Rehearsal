import { randomUUID } from "node:crypto";
import { orgTenant } from "@rehearsal/core";
import {
  APPLY_QUEUE,
  createDb,
  migrateDb,
  type PgBoss,
  PLAN_QUEUE,
  startQueue,
} from "@rehearsal/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureOrgSeeded, workerHasWork } from "../src/org-worlds";

describe("ensureOrgSeeded (#330)", () => {
  it("seeds an org once, even when callers race, and keeps orgs apart", async () => {
    const org = `org_${randomUUID()}`;
    const seeded: string[] = [];
    const seed = async (tenant: string) => {
      await new Promise((r) => setTimeout(r, 20));
      seeded.push(tenant);
    };
    await Promise.all([ensureOrgSeeded(org, { seed }), ensureOrgSeeded(org, { seed })]);
    await ensureOrgSeeded(org, { seed });
    expect(seeded).toEqual([orgTenant(org)]);
    const other = `org_${randomUUID()}`;
    await ensureOrgSeeded(other, { seed });
    expect(seeded).toEqual([orgTenant(org), orgTenant(other)]);
  });

  it("tries again after a failed seeding", async () => {
    const org = `org_${randomUUID()}`;
    let calls = 0;
    const seed = async () => {
      calls += 1;
      if (calls === 1) throw new Error("era down");
    };
    await expect(ensureOrgSeeded(org, { seed })).rejects.toThrow("era down");
    await ensureOrgSeeded(org, { seed });
    await ensureOrgSeeded(org, { seed });
    expect(calls).toBe(2);
  });
});

// Needs a real Postgres: `pnpm infra:up` then `DB_TESTS=1 pnpm --filter @rehearsal/api test`.
describe.skipIf(!process.env.DB_TESTS)("workerHasWork (#330, real pg-boss)", () => {
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

  it("is true only for the org whose job sits in that worker's own queue, until it finishes", async () => {
    const org = `org_${randomUUID()}`;
    const elsewhere = `org_${randomUUID()}`;
    const id = await boss.send(PLAN_QUEUE, {
      orgId: org,
      incidentId: "INC-BILL-0927",
      planId: `plan_${randomUUID()}`,
      requestedBy: "user_a",
    });
    if (!id) throw new Error("no job");
    expect(await workerHasWork(db, "planner", org)).toBe(true);
    // A plan job is no work for the executor, and nothing for another org.
    expect(await workerHasWork(db, "executor", org)).toBe(false);
    expect(await workerHasWork(db, "planner", elsewhere)).toBe(false);
    await boss.cancel(PLAN_QUEUE, id);
    expect(await workerHasWork(db, "planner", org)).toBe(false);

    const run = await boss.send(APPLY_QUEUE, {
      orgId: org,
      runId: `run_${randomUUID()}`,
      planId: "plan_x",
      revision: 1,
      planHash: "a".repeat(64),
    });
    if (!run) throw new Error("no job");
    expect(await workerHasWork(db, "executor", org)).toBe(true);
    await boss.cancel(APPLY_QUEUE, run);
    expect(await workerHasWork(db, "executor", org)).toBe(false);
  });
});
