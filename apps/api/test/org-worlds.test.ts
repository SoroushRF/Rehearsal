import { randomUUID } from "node:crypto";
import { orgTenant } from "@rehearsal/core";
import {
  APPLY_QUEUE,
  createDb,
  enqueuePlan,
  migrateDb,
  OrgWorldBusy,
  type PgBoss,
  PLAN_QUEUE,
  requestApply,
  startQueue,
  withOrgWorlds,
} from "@rehearsal/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ensureOrgSeeded,
  resetIdleOrgWorlds,
  resetOrgWorlds,
  workerHasWork,
} from "../src/org-worlds";

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

  it("waits for reset even when the org was already seeded, and retries after a failed reset", async () => {
    const org = `org_${randomUUID()}`;
    await ensureOrgSeeded(org, { seed: async () => {} });
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const resetting = resetOrgWorlds(org, {
      reset: async () => {
        entered();
        await blocked;
      },
    });
    await started;
    let returned = false;
    const seeding = ensureOrgSeeded(org).then(() => {
      returned = true;
    });
    await Promise.resolve();
    expect(returned).toBe(false);
    release();
    await Promise.all([resetting, seeding]);
    await expect(
      resetOrgWorlds(org, {
        reset: async () => {
          throw new Error("failed reset");
        },
      }),
    ).rejects.toThrow("failed reset");
    let seededAgain = false;
    await ensureOrgSeeded(org, {
      seed: async () => {
        seededAgain = true;
      },
    });
    expect(seededAgain).toBe(true);
  });
});

// Needs a real Postgres: `pnpm infra:up` then `DB_TESTS=1 pnpm --filter @rehearsal/api test`.
describe.skipIf(!process.env.DB_TESTS)("workerHasWork (#330, real pg-boss)", () => {
  const url = process.env.DATABASE_URL ?? "postgres://rehearsal:rehearsal@localhost:5432/rehearsal";
  const db = createDb(url);
  const other = createDb(url);
  let boss: PgBoss;
  beforeAll(async () => {
    await migrateDb(db);
    boss = await startQueue(url);
  });
  afterAll(async () => {
    await boss?.stop({ graceful: false });
    await db.$client.end();
    await other.$client.end();
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

  it("blocks planning, apply and a second reset across connections for the whole reset", async () => {
    const org = `org_${randomUUID()}`;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const resetting = resetIdleOrgWorlds(db, org, async () => {
      entered();
      await blocked;
    });
    await started;
    try {
      await expect(
        enqueuePlan(other, boss, { orgId: org }, async () => {
          throw new Error("seed ran during reset");
        }),
      ).rejects.toBeInstanceOf(OrgWorldBusy);
      await expect(
        requestApply(other, boss, {
          orgId: org,
          userId: "u",
          planId: "p",
          revision: 1,
          planHash: "a".repeat(64),
          now: new Date(),
        }),
      ).rejects.toBeInstanceOf(OrgWorldBusy);
      await expect(
        resetIdleOrgWorlds(other, org, async () => {
          throw new Error("second reset ran");
        }),
      ).rejects.toBeInstanceOf(OrgWorldBusy);
      await expect(
        withOrgWorlds(other, `org_${randomUUID()}`, async () => "other org works"),
      ).resolves.toBe("other org works");
    } finally {
      release();
      await resetting;
    }
    const id = await enqueuePlan(other, boss, { orgId: org }, async () => {});
    expect(id).toBeTruthy();
    await expect(
      resetIdleOrgWorlds(db, org, async () => {
        throw new Error("reset despite queued work");
      }),
    ).rejects.toBeInstanceOf(OrgWorldBusy);
    if (id) await boss.cancel(PLAN_QUEUE, id);
    await expect(resetIdleOrgWorlds(db, org, async () => {})).resolves.toBeUndefined();
  });

  it("releases the database lock after a failed reset", async () => {
    const org = `org_${randomUUID()}`;
    await expect(
      resetIdleOrgWorlds(db, org, async () => {
        throw new Error("Era down");
      }),
    ).rejects.toThrow("Era down");
    await expect(resetIdleOrgWorlds(other, org, async () => {})).resolves.toBeUndefined();
  });
});
