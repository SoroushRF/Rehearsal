import {
  createDb,
  type Db,
  loadRegistry,
  migrateDb,
  type PgBoss,
  PRECEDENT_QUEUE,
  schema,
  startQueue,
} from "@rehearsal/db";
import { AgentMemoryClient, AgentMemoryPrecedents, type PrecedentRecord } from "@rehearsal/memory";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeAgentMemory } from "../../../packages/memory/test/fake-agent-memory";
import { buildApp } from "../src/app";
import { type SimilarRecallerFor, similarRecallerFromEnv } from "../src/precedent-similar";
import { precedentScope, publisherFromEnv, syncPrecedent } from "../src/precedent-sync";
import { PromoteRequest, SimilarRequest } from "../src/precedents";
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

describe("similar precedents for the promote panel, before touching the database (T2.32)", () => {
  const ask = { appliesTo: content.appliesTo, statement: content.statement };
  const calls: string[] = [];
  const similar = () => ({
    recall: async (q: string) => {
      calls.push(q);
      return { precedents: [], traceId: null, rejected: [] };
    },
  });
  /** A database that finds run r1 in org_1 and refuses to be written. */
  const runDb = (state = "completed") => {
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
            return Promise.resolve([{ id: "r1", orgId: "org_1", state }]).then(ok);
          },
        };
        return chain;
      },
      transaction() {
        wrote = true;
        return Promise.reject(new Error("wrote"));
      },
      insert() {
        wrote = true;
        throw new Error("wrote");
      },
    };
    return { db: db as unknown as Db, wrote: () => wrote };
  };
  const as = (me: Caller | null, db: Db = {} as Db) => ({
    precedents: {
      db,
      boss: {} as PgBoss,
      iam: fakeIam(me ? [me] : []),
      syncEnabled: true,
      similar,
    },
  });
  const url = "/api/runs/r1/precedents/similar";

  it("is unavailable without a database", async () => {
    expect((await send({}, "POST", url, ask)).statusCode).toBe(503);
  });

  it("refuses a caller who isn't signed in", async () => {
    expect((await send(as(null), "POST", url, ask, null)).statusCode).toBe(401);
  });

  it("refuses a support lead: the hint needs rehearsal:promote:precedent", async () => {
    const lead = support("org_1");
    const { db, wrote } = runDb();
    const res = await send(as(lead, db), "POST", url, ask, lead);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden" });
    expect(wrote()).toBe(false);
    expect(calls).toEqual([]);
  });

  it("refuses a run that hasn't completed, without recalling", async () => {
    const person = finance("org_1");
    const res = await send(as(person, runDb("held").db), "POST", url, ask, person);
    expect(res.statusCode).toBe(409);
    expect(calls).toEqual([]);
  });

  it.each([
    ["no statement", { appliesTo: ask.appliesTo }],
    ["a blank statement", { ...ask, statement: "   " }],
    ["a statement over 2000 characters", { ...ask, statement: "x".repeat(2001) }],
    ["an area that isn't dotted lowercase", { ...ask, appliesTo: "Billing" }],
    ["an ID that isn't a slug", { ...ask, id: "Dup Refund" }],
    ["anything else, such as a version", { ...ask, version: 1 }],
  ])("refuses a body with %s", async (_label, body) => {
    const person = finance("org_1");
    const res = await send(as(person), "POST", url, body, person);
    expect(res.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it("accepts the area, the statement and an optional ID", () => {
    expect(SimilarRequest.safeParse(ask).success).toBe(true);
    expect(SimilarRequest.safeParse({ ...ask, id: "dup-refund" }).success).toBe(true);
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
      digest: string;
      sourceRunId: string | null;
    }[];

  /** A publisher that stores what it is given, as Agent Memory would after readback. */
  const published: PrecedentRecord[] = [];
  const marked: { id: string; version: number }[] = [];
  const markWithdrawn = async (id: string, version: number) => {
    marked.push({ id, version });
    return { id, version, factIds: [], scope: "s", written: true };
  };
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
    markWithdrawn,
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

  it("lists each version's digest and source run, so a citation can be traced to it (T2.31)", async () => {
    const { orgId, runId } = await seedRun();
    await promote(finance(orgId), runId);
    const { entries } = await loadRegistry(db, orgId);
    const [listed] = await list(finance(orgId));
    expect(listed?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(listed).toMatchObject({ digest: entries[0]?.digest, sourceRunId: runId });
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
        markWithdrawn,
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

    it("queues a job that retires the copy in Agent Memory (T1.51)", async () => {
      const { orgId } = await active();
      expect((await withdraw(finance(orgId), "dup-refund", 1)).statusCode).toBe(200);
      const queued = await db.execute<{ data: unknown }>(
        sql`select data from pgboss.job where name = ${PRECEDENT_QUEUE} and data->>'orgId' = ${orgId}`,
      );
      expect(queued.rows.map((r) => r.data)).toContainEqual({
        orgId,
        precedentId: "dup-refund",
        version: 1,
        kind: "withdraw",
      });

      const job = { orgId, precedentId: "dup-refund", version: 1, kind: "withdraw" };
      expect(await syncPrecedent(job, { db, publisherFor })).toBe("marked_withdrawn");
      expect(marked.at(-1)).toEqual({ id: "dup-refund", version: 1 });
      // The registry is unchanged: memory only follows it.
      expect((await list(finance(orgId)))[0]?.status).toBe("withdrawn");
    });

    it("doesn't put a withdrawn version's copy back when its publish job is redelivered", async () => {
      const { orgId } = await active();
      await withdraw(finance(orgId), "dup-refund", 1);
      const before = published.length;
      const job = { orgId, precedentId: "dup-refund", version: 1 };
      expect(await syncPrecedent(job, { db, publisherFor })).toBe("withdrawn");
      expect(published).toHaveLength(before);
    });

    it("leaves the copy to a newer approved version's sync, and marks nothing it can't find", async () => {
      const { orgId, runId } = await active();
      await withdraw(finance(orgId), "dup-refund", 1);
      await promote(finance(orgId), runId, { ...content, statement: "Changed." });
      const before = marked.length;
      const job = { orgId, precedentId: "dup-refund", version: 1, kind: "withdraw" };
      expect(await syncPrecedent(job, { db, publisherFor })).toBe("newer_version");

      const other = await active();
      const notWithdrawn = { ...job, orgId: other.orgId };
      expect(await syncPrecedent(notWithdrawn, { db, publisherFor })).toBe("no_such_version");
      expect(await syncPrecedent({ ...job, orgId: "org_x" }, { db, publisherFor })).toBe(
        "no_such_version",
      );
      expect(marked).toHaveLength(before);
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

  describe("similar active precedents on the promote panel (T2.32)", () => {
    // Agent Memory is the in-memory fake, reached with the API's own (write) key.
    const fake = new FakeAgentMemory();
    const env = {
      SURREAL_AGENT_MEMORY_URL: "https://memory.test",
      SURREAL_AGENT_MEMORY_CONTEXT: "ctx",
      SURREAL_AGENT_MEMORY_WRITE_KEY: "sp-test-key",
    };
    const must = <T>(value: T | null): T => {
      if (value === null) throw new Error("the fake memory env is incomplete");
      return value;
    };
    const memoryPublisher = must(publisherFromEnv(env, { fetch: fake.fetch }));
    const recallers = must(similarRecallerFromEnv(env, { fetch: fake.fetch }));

    /** `similar` defaults to recall through the fake; pass `{ similar: undefined }` for memory off. */
    const ask = (
      me: Caller,
      runId: string,
      body: object,
      options: { similar?: SimilarRecallerFor | null } = { similar: recallers },
    ) =>
      send(
        {
          precedents: {
            db,
            boss,
            iam: fakeIam([me]),
            syncEnabled: true,
            similar: options.similar,
            now: () => NOW,
          },
        },
        "POST",
        `/api/runs/${runId}/precedents/similar`,
        body,
        me,
      );
    const draft = {
      appliesTo: content.appliesTo,
      statement: "Refund a duplicate charge in full when it is within 30 days.",
    };

    /** Promotes and syncs a precedent. `toMemory: false` activates it without a copy in memory. */
    async function activate(
      orgId: string,
      runId: string,
      body: Partial<typeof content>,
      toMemory = true,
    ) {
      const full = { ...content, ...body };
      expect((await promote(finance(orgId), runId, full)).statusCode).toBe(201);
      const { entries } = await loadRegistry(db, orgId);
      const version = Math.max(...entries.filter((e) => e.id === full.id).map((e) => e.version));
      const job = { orgId, precedentId: full.id, version };
      const result = await syncPrecedent(job, {
        db,
        publisherFor: toMemory ? memoryPublisher : publisherFor,
      });
      expect(result).toBe("activated");
    }
    const queries = () => fake.requests.filter((r) => r.path.endsWith("/query")).length;

    it("shows an active precedent in the same area that recall finds, its statement from the registry", async () => {
      const { orgId, runId } = await seedRun();
      await activate(orgId, runId, {});
      const before = await loadRegistry(db, orgId);

      const res = await ask(finance(orgId), runId, { ...draft, id: "late-dup-refund" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: "ok",
        similar: [
          {
            id: "dup-refund",
            version: 1,
            appliesTo: content.appliesTo,
            statement: content.statement,
            digest: before.entries[0]?.digest,
            sameId: false,
          },
        ],
      });

      // An earlier version of the precedent being promoted is marked as such.
      const same = await ask(finance(orgId), runId, { ...draft, id: "dup-refund" });
      expect(same.json().similar).toMatchObject([{ id: "dup-refund", sameId: true }]);

      // Advisory only: nothing is stored, queued or changed.
      const after = await loadRegistry(db, orgId);
      expect(after.entries).toEqual(before.entries);
      const jobs = await db.execute<{ n: number }>(
        sql`select count(*)::int as n from pgboss.job where name = ${PRECEDENT_QUEUE} and data->>'orgId' = ${orgId}`,
      );
      expect(jobs.rows[0]?.n).toBe(1);
    });

    it("shows none when recall finds nothing active in the area", async () => {
      const { orgId, runId } = await seedRun();
      // Active in the area, but memory holds no copy, so recall can't find it.
      await activate(orgId, runId, {}, false);
      // Memory holds a copy of a precedent in another area; recall finds it, the area drops it.
      await activate(orgId, runId, {
        id: "late-fee-waiver",
        appliesTo: "billing.late_fee",
        statement: "A late fee charged in the first month is waived in full.",
      });
      const before = queries();
      const res = await ask(finance(orgId), runId, draft);
      expect(res.json()).toEqual({ status: "ok", similar: [] });
      expect(queries()).toBe(before + 1);
    });

    it("drops a withdrawn precedent whose copy memory still holds", async () => {
      const { orgId, runId } = await seedRun();
      await activate(orgId, runId, {});
      await activate(orgId, runId, {
        id: "dup-refund-small",
        statement: "A duplicate charge under 10.00 CAD is refunded without review.",
      });
      // Finance withdraws dup-refund; its sync job isn't run, so the fake still holds the copy.
      const withdrawn = await send(
        deps(finance(orgId)),
        "POST",
        "/api/precedents/dup-refund/withdraw",
        { version: 1 },
        finance(orgId),
      );
      expect(withdrawn.statusCode).toBe(200);
      const recalled = await recallers(orgId).recall(`${draft.appliesTo} ${draft.statement}`);
      expect(recalled.precedents.map((p) => p.id)).toContain("dup-refund");

      const res = await ask(finance(orgId), runId, draft);
      expect(res.json().status).toBe("ok");
      expect(res.json().similar.map((p: { id: string }) => p.id)).toEqual(["dup-refund-small"]);
    });

    it("drops a copy memory holds at an older version than the registry's active one", async () => {
      const { orgId, runId } = await seedRun();
      await activate(orgId, runId, {});
      // v2 is active in the registry, but its sync hasn't reached memory: recall still finds v1.
      await activate(orgId, runId, { statement: "Changed." }, false);
      const recalled = await recallers(orgId).recall(`${draft.appliesTo} ${draft.statement}`);
      expect(recalled.precedents.map((p) => [p.id, p.version])).toEqual([["dup-refund", 1]]);

      const res = await ask(finance(orgId), runId, draft);
      expect(res.json()).toEqual({ status: "ok", similar: [] });
    });

    it("never shows another organization's precedent, even with the same id and area", async () => {
      const mine = await seedRun();
      const theirs = await seedRun();
      // Both organizations have an active precedent with the same id in the same area.
      await activate(mine.orgId, mine.runId, {
        statement: "Mine: a duplicate charge in the first week is refunded in full.",
      });
      await activate(theirs.orgId, theirs.runId, {
        statement: "Theirs: a duplicate charge is never refunded.",
      });
      const res = await ask(finance(mine.orgId), mine.runId, draft);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("ok");
      expect(body.similar).toHaveLength(1);
      expect(body.similar[0].statement).toBe(
        "Mine: a duplicate charge in the first week is refunded in full.",
      );
      expect(JSON.stringify(body)).not.toContain("Theirs");
    });

    it("still finds a same-area precedent that ranks below more than ten others elsewhere", async () => {
      const { orgId, runId } = await seedRun();
      // Twelve off-area copies that match the draft far better than the one in its area.
      for (let i = 1; i <= 12; i++) {
        await activate(orgId, runId, {
          id: `late-fee-${i}`,
          appliesTo: "billing.late_fee",
          statement: draft.statement,
        });
      }
      await activate(orgId, runId, { id: "dup-credit", statement: "Credit small amounts." });

      // Ten hits wouldn't have reached it; the recaller asks for the service's cap.
      const closest = await new AgentMemoryPrecedents(
        new AgentMemoryClient({
          url: env.SURREAL_AGENT_MEMORY_URL,
          context: env.SURREAL_AGENT_MEMORY_CONTEXT,
          apiKey: env.SURREAL_AGENT_MEMORY_WRITE_KEY,
          fetch: fake.fetch,
        }),
        { scope: precedentScope("rehearsal/precedents", orgId) },
      ).recall(`${draft.appliesTo} ${draft.statement}`);
      expect(closest.precedents.map((p) => p.id)).not.toContain("dup-credit");

      const res = await ask(finance(orgId), runId, draft);
      expect(res.json().similar.map((p: { id: string }) => p.id)).toEqual(["dup-credit"]);
    });

    it("drops a precedent withdrawn while recall was in flight", async () => {
      const { orgId, runId } = await seedRun();
      await activate(orgId, runId, {});
      const slow: SimilarRecallerFor = (org) => ({
        recall: async (caseKey) => {
          const found = await recallers(org).recall(caseKey);
          // The registry changes after recall found it and before the route answers.
          const out = await send(
            deps(finance(orgId)),
            "POST",
            "/api/precedents/dup-refund/withdraw",
            { version: 1 },
            finance(orgId),
          );
          expect(out.statusCode).toBe(200);
          return found;
        },
      });
      const res = await ask(finance(orgId), runId, draft, { similar: slow });
      expect(res.json()).toEqual({ status: "ok", similar: [] });
    });

    it("says memory is off when Agent Memory isn't configured", async () => {
      const { orgId, runId } = await seedRun();
      await activate(orgId, runId, {});
      for (const similar of [undefined, null]) {
        const res = await ask(finance(orgId), runId, draft, { similar });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ status: "off", similar: [] });
      }
    });

    it("doesn't recall at all when nothing is active in the area", async () => {
      const { orgId, runId } = await seedRun();
      await activate(orgId, runId, { id: "late-fee-waiver", appliesTo: "billing.late_fee" });
      // A waiting precedent in the area isn't active either.
      await promote(finance(orgId), runId, { ...content, id: "dup-refund-waiting" });
      const before = fake.requests.length;
      const res = await ask(finance(orgId), runId, draft);
      expect(res.json()).toEqual({ status: "ok", similar: [] });
      expect(fake.requests.length).toBe(before);
    });

    it("says recall is unavailable on an outage or a timeout, and promotion still works", async () => {
      const { orgId, runId } = await seedRun();
      await activate(orgId, runId, {});
      fake.outage = 503;
      try {
        const res = await ask(finance(orgId), runId, draft);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ status: "unavailable", similar: [] });
      } finally {
        fake.outage = null;
      }

      const hanging = similarRecallerFromEnv(env, {
        fetch: () => new Promise<Response>(() => {}),
        timeoutMs: 50,
      });
      const slow = await ask(finance(orgId), runId, draft, { similar: hanging });
      expect(slow.json()).toEqual({ status: "unavailable", similar: [] });

      // The promote route never consults memory: the next version is approved as before.
      const promoted = await promote(finance(orgId), runId, { ...content, statement: "Changed." });
      expect(promoted.statusCode).toBe(201);
      expect(promoted.json().precedent).toMatchObject({ version: 2, status: "waiting" });
    });

    it("refuses a run that hasn't completed and another org's run", async () => {
      const held = await seedRun("held");
      const res = await ask(finance(held.orgId), held.runId, draft);
      expect(res.statusCode).toBe(409);
      const done = await seedRun();
      expect((await ask(finance("org_other"), done.runId, draft)).statusCode).toBe(404);
    });
  });
});
