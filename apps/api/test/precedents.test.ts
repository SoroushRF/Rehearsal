import {
  createDb,
  type Db,
  loadRegistry,
  migrateDb,
  type PgBoss,
  schema,
  startQueue,
} from "@rehearsal/db";
import type { PrecedentRecord } from "@rehearsal/memory";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { precedentScope, syncPrecedent } from "../src/precedent-sync";
import { PromoteRequest } from "../src/precedents";
import { bearer, type Caller, fakeIam, finance, support } from "./fake-iam";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const content = {
  id: "dup-refund",
  appliesTo: "billing.duplicate_charge",
  statement: "A duplicate charge found within 30 days is refunded in full.",
  conditions: ["same amount and customer"],
  exceptions: ["charges at or above 100.00 CAD go to finance first"],
  effectiveFrom: "2026-10-01",
  effectiveUntil: null,
};

async function send(
  deps: Parameters<typeof buildApp>[0],
  method: "GET" | "POST",
  url: string,
  payload?: object,
  person?: Caller | null,
) {
  const app = buildApp({ webRoot: null, ...deps });
  try {
    return await app.inject({
      method,
      url,
      headers: person ? bearer(person) : {},
      ...(payload ? { payload } : {}),
    });
  } finally {
    await app.close();
  }
}

describe("promoting a precedent, before touching the database", () => {
  const as = (me: Caller | null) => ({
    precedents: {
      db: {} as Db,
      boss: {} as PgBoss,
      iam: fakeIam(me ? [me] : []),
      syncEnabled: false,
    },
  });

  it("is unavailable without a database", async () => {
    expect((await send({}, "POST", "/api/runs/r1/precedents", content)).statusCode).toBe(503);
    expect((await send({}, "GET", "/api/precedents")).statusCode).toBe(503);
  });

  it("refuses a caller who isn't signed in", async () => {
    expect(
      (await send(as(null), "POST", "/api/runs/r1/precedents", content, null)).statusCode,
    ).toBe(401);
    expect((await send(as(null), "GET", "/api/precedents", undefined, null)).statusCode).toBe(401);
  });

  it("refuses a support lead: promotion needs rehearsal:promote:precedent", async () => {
    const lead = support("org_1");
    let wrote = false;
    const db = {
      select() {
        const chain = {
          from() {
            return chain;
          },
          where() {
            return chain;
          },
          // biome-ignore lint/suspicious/noThenProperty: the stub is the thenable Drizzle returns
          then(ok: (rows: unknown[]) => unknown) {
            return Promise.resolve([{ id: "r1", orgId: "org_1", state: "completed" }]).then(ok);
          },
        };
        return chain;
      },
      transaction() {
        wrote = true;
        return Promise.reject(new Error("wrote"));
      },
    };
    const res = await send(
      {
        precedents: {
          db: db as unknown as Db,
          boss: {} as PgBoss,
          iam: fakeIam([lead]),
          syncEnabled: false,
        },
      },
      "POST",
      "/api/runs/r1/precedents",
      content,
      lead,
    );
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden" });
    expect(wrote).toBe(false);
  });

  it.each([
    [
      "an author supplied by the browser",
      { ...content, author: { userId: "x", role: "finance_lead" } },
    ],
    ["a version supplied by the browser", { ...content, version: 9 }],
    [
      "an approval time supplied by the browser",
      { ...content, approvedAt: "2026-01-01T00:00:00Z" },
    ],
    ["a blank statement", { ...content, statement: "  " }],
    ["an ID that isn't a slug", { ...content, id: "Dup Refund" }],
    ["an area that isn't dotted lowercase", { ...content, appliesTo: "Billing" }],
    ["a malformed date", { ...content, effectiveFrom: "tomorrow" }],
  ])("refuses a body with %s", async (_label, body) => {
    const person = finance("org_1");
    const res = await send(as(person), "POST", "/api/runs/r1/precedents", body, person);
    expect(res.statusCode).toBe(400);
  });
});

describe("withdrawing a precedent, before touching the database", () => {
  const as = (me: Caller | null) => ({
    precedents: {
      db: {} as Db,
      boss: {} as PgBoss,
      iam: fakeIam(me ? [me] : []),
      syncEnabled: false,
    },
  });
  const withdraw = (me: Caller | null, body: object = { version: 1 }) =>
    send(as(me), "POST", "/api/precedents/dup-refund/withdraw", body, me);

  it("is unavailable without a database", async () => {
    const res = await send({}, "POST", "/api/precedents/dup-refund/withdraw", { version: 1 });
    expect(res.statusCode).toBe(503);
  });

  it("refuses a caller who isn't signed in", async () => {
    expect((await withdraw(null)).statusCode).toBe(401);
  });

  it("refuses a support lead without writing", async () => {
    const lead = support("org_1");
    let wrote = false;
    const db = {
      select() {
        const chain = {
          from() {
            return chain;
          },
          where() {
            return chain;
          },
          // biome-ignore lint/suspicious/noThenProperty: the stub is the thenable Drizzle returns
          then(ok: (rows: unknown[]) => unknown) {
            return Promise.resolve([{ orgId: "org_1" }]).then(ok);
          },
        };
        return chain;
      },
      transaction() {
        wrote = true;
        return Promise.reject(new Error("wrote"));
      },
    };
    const res = await send(
      {
        precedents: {
          db: db as unknown as Db,
          boss: {} as PgBoss,
          iam: fakeIam([lead]),
          syncEnabled: false,
        },
      },
      "POST",
      "/api/precedents/dup-refund/withdraw",
      { version: 1 },
      lead,
    );
    expect(res.statusCode).toBe(403);
    expect(wrote).toBe(false);
  });

  it.each([
    ["no version", {}],
    ["a version that isn't a positive integer", { version: 0 }],
    ["anything besides the version", { version: 1, status: "withdrawn" }],
  ])("refuses a body with %s", async (_label, body) => {
    expect((await withdraw(finance("org_1"), body)).statusCode).toBe(400);
  });
});

describe("the request and the scope", () => {
  it("accepts exactly the finance lead's content", () => {
    expect(PromoteRequest.safeParse(content).success).toBe(true);
    expect(PromoteRequest.safeParse({ ...content, effectiveUntil: "2027-01-01" }).success).toBe(
      true,
    );
  });

  it("gives each organization its own lowercase memory scope", () => {
    const a = precedentScope("rehearsal/precedents", "org_2AbCdEf");
    const b = precedentScope("rehearsal/precedents", "org_2abcdef");
    expect(a).toMatch(/^rehearsal\/precedents\/org-[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
    expect(precedentScope("rehearsal/precedents", "org_2AbCdEf")).toBe(a);
  });
});

// Needs a real Postgres: `pnpm infra:up` then `DB_TESTS=1 pnpm --filter @rehearsal/api test`.
describe.skipIf(!process.env.DB_TESTS)("promoting a precedent (real Postgres)", () => {
  const url = process.env.DATABASE_URL ?? "postgres://rehearsal:rehearsal@localhost:5432/rehearsal";
  const db = createDb(url);
  let boss: PgBoss;
  beforeAll(async () => {
    await migrateDb(db);
    boss = await startQueue(url);
  });
  afterAll(async () => {
    await boss?.stop({ graceful: false });
  });

  const deps = (me: Caller | null) => ({
    precedents: { db, boss, iam: fakeIam(me ? [me] : []), syncEnabled: true, now: () => NOW },
  });

  async function seedRun(state = "completed") {
    const orgId = `org_${crypto.randomUUID()}`;
    const runId = `run_${crypto.randomUUID()}`;
    await db.insert(schema.runs).values({
      id: runId,
      orgId,
      planId: `plan_${crypto.randomUUID()}`,
      revision: 1,
      planHash: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
      approvalId: "grant_1",
      requestedBy: "user_fin",
      state,
    });
    return { orgId, runId };
  }
  const promote = (me: Caller, runId: string, body: object = content) =>
    send(deps(me), "POST", `/api/runs/${runId}/precedents`, body, me);
  const list = async (me: Caller) =>
    (await send(deps(me), "GET", "/api/precedents", undefined, me)).json().precedents as {
      id: string;
      version: number;
      status: string;
      author: string;
    }[];

  /** A publisher that stores what it is given, as Agent Memory would after readback. */
  const published: PrecedentRecord[] = [];
  const publisherFor = () => ({
    publish: async (record: PrecedentRecord) => {
      published.push(record);
      return {
        id: record.id,
        version: record.version,
        digest: "x".repeat(64) as never,
        factIds: [],
        scope: "s",
        written: true,
      };
    },
  });

  it("records the approved version as waiting, with the author set from the verified user", async () => {
    const { orgId, runId } = await seedRun();
    const res = await promote(finance(orgId), runId);
    expect(res.statusCode).toBe(201);
    expect(res.json().precedent).toMatchObject({ id: "dup-refund", version: 1, status: "waiting" });
    expect(await list(finance(orgId))).toMatchObject([
      { id: "dup-refund", version: 1, status: "waiting", author: "user_fin" },
    ]);
  });

  it("refuses a run that hasn't completed, another org's run and an unknown run", async () => {
    const held = await seedRun("held");
    expect((await promote(finance(held.orgId), held.runId)).statusCode).toBe(409);
    const done = await seedRun();
    expect((await promote(finance("org_other"), done.runId)).statusCode).toBe(404);
    expect((await promote(finance(done.orgId), "run_nope")).statusCode).toBe(404);
    expect(await list(finance(held.orgId))).toEqual([]);
  });

  it("refuses a record the memory package would refuse (an end date before the start)", async () => {
    const { orgId, runId } = await seedRun();
    const res = await promote(finance(orgId), runId, {
      ...content,
      effectiveUntil: "2026-09-01",
    });
    expect(res.statusCode).toBe(422);
    expect(await list(finance(orgId))).toEqual([]);
  });

  it("makes a second promotion of the same precedent the next version, in the same area", async () => {
    const { orgId, runId } = await seedRun();
    await promote(finance(orgId), runId);
    const second = await promote(finance(orgId), runId, { ...content, statement: "Changed." });
    expect(second.json().precedent).toMatchObject({ version: 2 });
    const other = await promote(finance(orgId), runId, { ...content, appliesTo: "billing.other" });
    expect(other.statusCode).toBe(409);
    expect(other.json()).toMatchObject({ error: "area_changed" });
  });

  it("activates only after the sync has published and read it back", async () => {
    const { orgId, runId } = await seedRun();
    await promote(finance(orgId), runId);
    expect((await list(finance(orgId)))[0]?.status).toBe("waiting");

    const failing = {
      publisherFor: () => ({
        publish: async () => {
          throw new Error("Agent Memory is down");
        },
      }),
    };
    await expect(
      syncPrecedent({ orgId, precedentId: "dup-refund", version: 1 }, { db, ...failing }),
    ).rejects.toThrow("down");
    expect((await list(finance(orgId)))[0]?.status).toBe("waiting");

    const job = { orgId, precedentId: "dup-refund", version: 1 };
    expect(await syncPrecedent(job, { db, publisherFor })).toBe("activated");
    expect(published.at(-1)).toMatchObject({
      id: "dup-refund",
      version: 1,
      author: { userId: "user_fin" },
    });
    expect((await list(finance(orgId)))[0]?.status).toBe("active");
    // A retried job changes nothing.
    expect(await syncPrecedent(job, { db, publisherFor })).toBe("already_active");
  });

  it("supersedes the old version once the new one syncs", async () => {
    const { orgId, runId } = await seedRun();
    await promote(finance(orgId), runId);
    await syncPrecedent({ orgId, precedentId: "dup-refund", version: 1 }, { db, publisherFor });
    await promote(finance(orgId), runId, { ...content, statement: "Changed." });
    await syncPrecedent({ orgId, precedentId: "dup-refund", version: 2 }, { db, publisherFor });
    expect((await list(finance(orgId))).map((p) => [p.version, p.status]).sort()).toEqual([
      [1, "superseded"],
      [2, "active"],
    ]);
  });

  it("says no such version for a job whose approval doesn't exist", async () => {
    const job = { orgId: "org_x", precedentId: "nope", version: 1 };
    expect(await syncPrecedent(job, { db, publisherFor })).toBe("no_such_version");
  });

  it("keeps organizations apart", async () => {
    const a = await seedRun();
    const b = await seedRun();
    await promote(finance(a.orgId), a.runId);
    expect(await list(finance(b.orgId))).toEqual([]);
  });

  describe("withdrawing (#233)", () => {
    const withdraw = (me: Caller, id: string, version: number) =>
      send(deps(me), "POST", `/api/precedents/${id}/withdraw`, { version }, me);
    async function active() {
      const { orgId, runId } = await seedRun();
      await promote(finance(orgId), runId);
      await syncPrecedent({ orgId, precedentId: "dup-refund", version: 1 }, { db, publisherFor });
      return { orgId, runId };
    }

    it("withdraws the active version: it leaves the snapshot and its area's epoch moves", async () => {
      const { orgId } = await active();
      const before = await loadRegistry(db, orgId);
      expect(before.snapshot.active.get("dup-refund")?.version).toBe(1);

      const res = await withdraw(finance(orgId), "dup-refund", 1);
      expect(res.statusCode).toBe(200);
      expect(res.json().precedent).toMatchObject({ version: 1, status: "withdrawn" });

      const after = await loadRegistry(db, orgId);
      expect(after.snapshot.active.has("dup-refund")).toBe(false);
      expect(after.snapshot.epochs.get(content.appliesTo)).toBe(
        (before.snapshot.epochs.get(content.appliesTo) ?? 0) + 1,
      );
      expect((await list(finance(orgId)))[0]?.status).toBe("withdrawn");
    });

    it("refuses a version that isn't the active one, so a stale page can't withdraw a newer one", async () => {
      const { orgId, runId } = await active();
      await promote(finance(orgId), runId, { ...content, statement: "Changed." });
      await syncPrecedent({ orgId, precedentId: "dup-refund", version: 2 }, { db, publisherFor });
      const res = await withdraw(finance(orgId), "dup-refund", 1);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: "stale_version", activeVersion: 2 });
    });

    it("refuses a precedent that is only waiting, or already withdrawn", async () => {
      const { orgId, runId } = await seedRun();
      await promote(finance(orgId), runId);
      expect((await withdraw(finance(orgId), "dup-refund", 1)).json()).toEqual({
        error: "not_active",
      });

      const done = await active();
      expect((await withdraw(finance(done.orgId), "dup-refund", 1)).statusCode).toBe(200);
      expect((await withdraw(finance(done.orgId), "dup-refund", 1)).statusCode).toBe(409);
    });

    it("can't reach another organization's precedent", async () => {
      await active();
      const res = await withdraw(finance(`org_${crypto.randomUUID()}`), "dup-refund", 1);
      expect(res.statusCode).toBe(404);
    });

    it("lets two withdrawals race and records only one", async () => {
      const { orgId } = await active();
      const results = await Promise.all([
        withdraw(finance(orgId), "dup-refund", 1),
        withdraw(finance(orgId), "dup-refund", 1),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      const events = await db
        .select()
        .from(schema.precedentEvents)
        .where(eq(schema.precedentEvents.orgId, orgId));
      expect(events.filter((e) => e.kind === "withdrawn")).toHaveLength(1);
    });
  });
});
