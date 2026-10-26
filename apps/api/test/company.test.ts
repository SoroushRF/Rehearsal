import { randomUUID } from "node:crypto";
import { CompanySnapshot, type Receipt } from "@rehearsal/contracts";
import { planHash } from "@rehearsal/core";
import { createDb, type Db, migrateDb, schema } from "@rehearsal/db";
import { happyPathBundle } from "@rehearsal/testkit";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import type { CompanyDeps, CompanyWorld } from "../src/company";
import { bearer, type Caller, fakeIam, member } from "./fake-iam";

/** A small world: what the stubbed operational read returns for an org. */
const WORLD: CompanyWorld = {
  charges: [
    {
      id: "ch_dup_1",
      customer: "cus_1",
      invoice: "in_1",
      amountMinor: 4210,
      currency: "cad",
      created: "2026-09-10T12:00:00.000Z",
      refundedMinor: 0,
    },
  ],
  customers: [{ id: "cus_1", email: "a@example.test", balanceMinor: 0 }],
  tickets: [
    {
      id: 7,
      subject: "Charged twice",
      status: "open",
      priority: "normal",
      requester: "41",
      updatedAt: "2026-09-12T10:00:00.000Z",
    },
  ],
  slack: [],
};

async function get(deps: CompanyDeps, person?: Caller | null) {
  const app = buildApp({ webRoot: null, company: deps });
  const res = await app.inject({
    method: "GET",
    url: "/api/company",
    headers: person ? bearer(person) : {},
  });
  await app.close();
  return res;
}

describe("GET /api/company without a database", () => {
  it("is 401 without a session and 503 without IAM", async () => {
    const db = {} as Db;
    expect((await get({ db, iam: fakeIam([]), readWorld: async () => WORLD })).statusCode).toBe(
      401,
    );
    const person = member("org_x");
    expect((await get({ db, readWorld: async () => WORLD }, person)).statusCode).toBe(503);
  });
});

// Needs a real Postgres: `pnpm infra:up` then `DB_TESTS=1 pnpm --filter @rehearsal/api test`.
describe.skipIf(!process.env.DB_TESTS)("GET /api/company (#330, real Postgres)", () => {
  const url = process.env.DATABASE_URL ?? "postgres://rehearsal:rehearsal@localhost:5432/rehearsal";
  const db = createDb(url);
  beforeAll(() => migrateDb(db));

  /** An org with a stored plan, a run of it, and one receipt per given outcome for refund_001. */
  async function seeded(outcomes: Receipt["outcome"][]) {
    const orgId = `org_${randomUUID()}`;
    const planId = `plan_${randomUUID()}`;
    const manifest = { ...happyPathBundle().manifest, orgId, planId };
    const hash = planHash(manifest);
    await db
      .insert(schema.planVersions)
      .values({ orgId, planId, revision: 1, planHash: hash, manifest });
    const runId = `run_${randomUUID()}`;
    await db.insert(schema.runs).values({
      id: runId,
      orgId,
      planId,
      revision: 1,
      planHash: hash,
      approvalId: "grant_1",
      requestedBy: "user_1",
      state: "completed",
    });
    const refund = manifest.actions.find((a) => a.id === "refund_001");
    const patch = manifest.actions.find((a) => a.id === "patch_001");
    if (refund?.kind !== "stripe.refund.create" || patch?.kind !== "zendesk.ticket.patchFields") {
      throw new Error("fixture plan changed");
    }
    const receipt = (actionId: string, outcome: Receipt["outcome"], at: number): Receipt => ({
      id: `rc_${randomUUID()}`,
      actionId,
      planHash: hash,
      approvalId: "grant_1",
      outcome,
      providerRef: null,
      observedEffect: {},
      protection: "best_effort_reread",
      holdReason: null,
      limitations: [],
      recordedAt: new Date(Date.UTC(2026, 9, 25, 12, 0, at)).toISOString(),
    });
    const rows = [
      ...outcomes.map((o, i) => receipt("refund_001", o, i)),
      receipt("patch_001", "confirmed", 10),
    ];
    await db.insert(schema.stepReceipts).values(
      rows.map((r) => ({
        id: r.id,
        orgId,
        planHash: hash,
        actionId: r.actionId,
        receipt: r,
        recordedAt: new Date(r.recordedAt),
      })),
    );
    return { orgId, runId, chargeId: refund.args.chargeId, ticketId: patch.args.ticketId };
  }

  it("returns the org's world as a snapshot the contract accepts", async () => {
    const orgId = `org_${randomUUID()}`;
    const person = member(orgId);
    const asked: string[] = [];
    const res = await get(
      {
        db,
        iam: fakeIam([person]),
        readWorld: async (org) => {
          asked.push(org);
          return WORLD;
        },
        now: () => new Date("2026-10-25T23:00:00.000Z"),
      },
      person,
    );
    expect(res.statusCode).toBe(200);
    const body = CompanySnapshot.parse(res.json());
    expect(body).toMatchObject({ asOf: "2026-10-25T23:00:00.000Z", changed: {} });
    expect(body.charges.map((c) => c.id)).toEqual(["ch_dup_1"]);
    // The org comes from the verified session, never from the request.
    expect(asked).toEqual([orgId]);
  });

  it("marks the records a confirmed write changed, with its run", async () => {
    const s = await seeded(["unknown_outcome", "confirmed"]);
    const person = member(s.orgId);
    const res = await get({ db, iam: fakeIam([person]), readWorld: async () => WORLD }, person);
    expect(res.statusCode).toBe(200);
    expect(res.json().changed).toEqual({ [s.chargeId]: s.runId, [s.ticketId]: s.runId });
  });

  it("does not mark a write that never confirmed", async () => {
    const s = await seeded(["held"]);
    const person = member(s.orgId);
    const res = await get({ db, iam: fakeIam([person]), readWorld: async () => WORLD }, person);
    expect(res.json().changed).toEqual({ [s.ticketId]: s.runId });
  });

  it("another org sees none of this org's changes", async () => {
    await seeded(["confirmed"]);
    const other = member(`org_${randomUUID()}`);
    const res = await get({ db, iam: fakeIam([other]), readWorld: async () => WORLD }, other);
    expect(res.statusCode).toBe(200);
    expect(res.json().changed).toEqual({});
  });

  it("seeds a new org before its first read, and answers 502 when the world can't be read", async () => {
    const person = member(`org_${randomUUID()}`);
    const order: string[] = [];
    const ok = await get(
      {
        db,
        iam: fakeIam([person]),
        ensureSeeded: async () => {
          order.push("seed");
        },
        readWorld: async () => {
          order.push("read");
          return WORLD;
        },
      },
      person,
    );
    expect(ok.statusCode).toBe(200);
    expect(order).toEqual(["seed", "read"]);
    const down = await get(
      {
        db,
        iam: fakeIam([person]),
        readWorld: async () => {
          throw new Error("era down");
        },
      },
      person,
    );
    expect(down.statusCode).toBe(502);
    expect(down.json()).toEqual({ error: "world_unavailable" });
  });

  it("a member of another org can't be served this org's world", async () => {
    const s = await seeded(["confirmed"]);
    const intruder = member(`org_${randomUUID()}`);
    const asked: string[] = [];
    await get(
      {
        db,
        iam: fakeIam([intruder]),
        readWorld: async (org) => {
          asked.push(org);
          return WORLD;
        },
      },
      intruder,
    );
    expect(asked).not.toContain(s.orgId);
  });
});
