import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { PlanManifest, Receipt } from "@rehearsal/contracts";
import { planHash } from "@rehearsal/core";
import {
  approvePrecedent,
  type Db,
  loadRegistry,
  lockOrgMemoryShared,
  memoryErased,
  memoryErasureEventsFor,
  migrateDb,
  type PgBoss,
  PgJournal,
  recordMemoryErasure,
  recordPrecedentEvent,
  schema,
  startQueue,
} from "@rehearsal/db";
import {
  AgentMemoryClient,
  AgentMemoryPrecedents,
  type PrecedentRecord,
  precedentDigest,
  precedentScope,
} from "@rehearsal/memory";
import { PLANNER_JOB_ROUTES, PlanJob } from "@rehearsal/providers";
import { billingManifest, INCIDENT } from "@rehearsal/testkit";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedTestDatabase } from "../../../packages/db/test/isolated-db";
import { FakeAgentMemory } from "../../../packages/memory/test/fake-agent-memory";
import { runDrift } from "../../../scripts/memory/drift-run";
import {
  databaseTarget,
  type EraseOrgRun,
  EraseRefused,
  eraseOrg,
} from "../../../scripts/memory/erase-run";
import { adminFor } from "../../../scripts/memory/keys-run";
import { buildApp } from "../src/app";
import { loadPlan, storePlan } from "../src/plans";
import { precedentCheck } from "../src/precedent-check";
import { similarRecallerFromEnv } from "../src/precedent-similar";
import { publisherFromEnv, syncPrecedent } from "../src/precedent-sync";
import { checkJobBasis, planJobRegistry } from "../src/rehearse";
import { bearer, fakeIam, finance, support } from "./fake-iam";

const BASE = "rehearsal/precedents";
const AREA = "billing.duplicate_charge";
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function record(id: string, version = 1): PrecedentRecord {
  return {
    id,
    version,
    appliesTo: AREA,
    statement: `Duplicate charge rule ${id} v${version}: refund in full.`,
    conditions: ["same amount and customer"],
    exceptions: [],
    effectiveFrom: "2026-10-01",
    effectiveUntil: null,
    author: { userId: "user_fin", role: "finance_lead" },
    approvedAt: "2026-10-24T12:00:00Z",
  };
}

/** `pnpm memory:erase-org` itself, as a child process with exactly `env` (plus PATH). */
function cli(args: string[], env: Record<string, string> = {}, stdin = "") {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "scripts/memory/erase-org.ts", ...args],
      {
        cwd: ROOT,
        env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "", ...env },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

describe("pnpm memory:erase-org usage", () => {
  it("exits 2 on bad usage or a --yes that doesn't match, before reading any credential", async () => {
    for (const args of [
      [],
      ["-x"],
      ["org_a", "org_b"],
      ["org_a", "--yes"],
      ["org_a", "--yes", "org_a", "--yes", "org_a"],
      ["org/a"],
    ]) {
      const res = await cli(args);
      expect([args.join(" "), res.status]).toEqual([args.join(" "), 2]);
      expect(res.stderr).toContain("usage: pnpm memory:erase-org");
    }
    const mismatch = await cli(["org_a", "--yes", "org_b"]);
    expect(mismatch.status).toBe(2);
    expect(mismatch.stderr).toContain("doesn't match org_a");
    // Usage is fine, but there are no credentials.
    expect((await cli(["org_a", "--yes", "org_a"])).status).toBe(3);
  }, 60_000);
});

// Needs a real Postgres: `DB_TESTS=1 DATABASE_URL=… pnpm --filter @rehearsal/api test`.
describe.skipIf(!process.env.DB_TESTS)("erasing an org's Agent Memory (real Postgres)", () => {
  const database = isolatedTestDatabase();
  const { db, url } = database;
  const fake = new FakeAgentMemory();
  // The fake's default key is its admin; the sync and the hint use it as their write key here.
  const env = {
    SURREAL_AGENT_MEMORY_URL: "http://fake/",
    SURREAL_AGENT_MEMORY_CONTEXT: "ctx",
    SURREAL_AGENT_MEMORY_WRITE_KEY: "sp-test-key",
  };
  const publisherFor = publisherFromEnv(env, { fetch: fake.fetch });
  const similar = similarRecallerFromEnv(env, { fetch: fake.fetch });
  const memory = { url: "http://fake/", context: "ctx", apiKey: "sp-test-key", fetch: fake.fetch };
  const admin = adminFor(memory);
  const client = new AgentMemoryClient(memory);
  let boss: PgBoss;
  // The CLI runs in a child process, so it reaches the fake over HTTP.
  let server: Server;
  let fakeUrl = "";

  beforeAll(async () => {
    await database.create();
    await migrateDb(db);
    boss = await startQueue(url);
    await boss.updateQueue("plan", { retryDelay: 0 });
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString("utf8");
      const answer = await fake.fetch(`http://fake${req.url}`, {
        method: req.method ?? "GET",
        headers: { authorization: req.headers.authorization ?? "" },
        ...(body === "" ? {} : { body }),
      });
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(await answer.text());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    fakeUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(async () => {
    await boss?.stop({ graceful: false });
    await new Promise((resolve) => server?.close(resolve));
    await database.drop();
  });

  const cliEnv = () => ({
    DATABASE_URL: url,
    SURREAL_AGENT_MEMORY_URL: fakeUrl,
    SURREAL_AGENT_MEMORY_CONTEXT: "ctx",
    SURREAL_AGENT_MEMORY_ADMIN_KEY: "sp-test-key",
  });

  async function approve(orgId: string, r: PrecedentRecord) {
    await approvePrecedent(db, {
      orgId,
      precedentId: r.id,
      version: r.version,
      appliesTo: r.appliesTo,
      digest: precedentDigest(r),
      record: r,
      actorUserId: "user_fin",
      sourceRunId: "run_1",
    });
  }
  async function synced(orgId: string, r: PrecedentRecord) {
    await approve(orgId, r);
    if (publisherFor === null) throw new Error("memory not configured");
    const job = { orgId, precedentId: r.id, version: r.version };
    expect(await syncPrecedent(job, { db, publisherFor })).toBe("activated");
  }
  /** An org with two active precedents and a planted copy the registry never approved. */
  async function orgWithMemory() {
    if (publisherFor === null) throw new Error("memory not configured");
    const orgId = `org_${crypto.randomUUID()}`;
    await synced(orgId, record("one"));
    await synced(orgId, record("two"));
    await publisherFor(orgId).publish(record("planted"));
    return orgId;
  }
  const inScope = (orgId: string) =>
    fake.attrs.filter((a) => a.scope[0]?.[0] === `${precedentScope(BASE, orgId)}/`).length;
  const eraseRun = (orgId: string, over: Partial<EraseOrgRun> = {}): Promise<EraseOrgRun> =>
    (async () => ({
      admin,
      client,
      baseScope: BASE,
      orgId,
      registry: (await loadRegistry(db, orgId)).entries,
      alreadyErased: await memoryErased(db, orgId),
      confirm: async () => true,
      record: async (kind, scope, summary) => {
        await recordMemoryErasure(db, { orgId, kind, scope, summary, operator: "test" });
      },
      log: () => {},
      ...over,
    }))();

  it("dry-runs first: lists the scope, its entities and attribute counts, and changes nothing; a wrong confirmation aborts", async () => {
    const orgId = await orgWithMemory();
    const other = await orgWithMemory();
    const attrs = fake.attrs.length;
    const writes = fake.writes;
    const before = fake.requests.length;

    const lines: string[] = [];
    const out = await eraseOrg(
      await eraseRun(orgId, { confirm: async () => false, log: (l) => lines.push(l) }),
    );
    expect(out.outcome).toBe("aborted");
    expect(out.listing).toMatchObject({
      orgId,
      scope: precedentScope(BASE, orgId),
      registered: "registered",
      registryIds: ["one", "two"],
    });
    // The planted copy is found through recall, though the registry never approved it.
    expect(out.listing.entities).toEqual([
      { name: "precedent:one", live: 3, history: 3 },
      { name: "precedent:planted", live: 3, history: 3 },
      { name: "precedent:two", live: 3, history: 3 },
    ]);
    expect(lines[0]).toMatch(/^Dry run \(reads only/);
    expect(lines.at(-1)).toMatch(/^aborted/);
    // Reads only: nothing was written, forgotten, tombstoned or recorded.
    const sent = fake.requests.slice(before).map((r) => `${r.method} ${r.path.split("?")[0]}`);
    expect(sent.filter((r) => !r.startsWith("GET ") && !r.endsWith("/query"))).toEqual([]);
    expect([fake.attrs.length, fake.writes]).toEqual([attrs, writes]);
    expect(await memoryErasureEventsFor(db, orgId)).toEqual([]);
    expect(await memoryErased(db, orgId)).toBe(false);

    // The command itself, with a mistyped confirmation: the same dry run, then exit 1.
    const typo = await cli([orgId], cliEnv(), `${other}\n`);
    expect(typo.status).toBe(1);
    expect(typo.stdout).toContain("precedent:planted: 3 live, 3 in history");
    expect(typo.stdout).toContain("aborted");
    // And with no answer at all (stdin closed).
    expect((await cli([orgId], cliEnv(), "")).status).toBe(1);
    expect([fake.attrs.length, fake.writes]).toEqual([attrs, writes]);
    expect(await memoryErasureEventsFor(db, orgId)).toEqual([]);
  }, 60_000);

  it("on the typed org ID, records erased before forgetting, then erases and tombstones only that scope; the registry is untouched", async () => {
    const orgId = await orgWithMemory();
    const other = await orgWithMemory();
    const registry = await loadRegistry(db, orgId);
    const otherAttrs = inScope(other);

    const res = await cli([orgId], cliEnv(), `${orgId}\n`);
    expect([res.status, res.stderr]).toEqual([0, ""]);
    expect(res.stdout).toContain("recorded erased");
    expect(res.stdout).toContain("tombstoned");

    const events = await memoryErasureEventsFor(db, orgId);
    expect(events.map((e) => [e.kind, e.scope])).toEqual([
      ["erased", precedentScope(BASE, orgId)],
      ["forgotten", precedentScope(BASE, orgId)],
    ]);
    expect(events[0]?.summary).toMatchObject({ registryIds: ["one", "two"] });
    expect(events[1]?.summary).toEqual({ forgotten: 9, tombstoned: true });
    expect(inScope(orgId)).toBe(0);
    expect(fake.tombstoned.has(precedentScope(BASE, orgId))).toBe(true);
    expect(inScope(other)).toBe(otherAttrs);
    // Postgres still decides: the same active versions and epochs as before.
    expect(await loadRegistry(db, orgId)).toEqual(registry);
    // Nothing can write the scope again, even through the API's own publisher.
    await expect(publisherFor?.(orgId).publish(record("three"))).rejects.toMatchObject({
      status: 400,
    });

    // --yes for scripts: the same ID twice. A second run appends a second pair.
    expect((await cli([orgId, "--yes", orgId], cliEnv())).status).toBe(0);
    expect((await memoryErasureEventsFor(db, orgId)).map((e) => e.kind)).toEqual([
      "erased",
      "forgotten",
      "erased",
      "forgotten",
    ]);
  }, 60_000);

  it("records erased before it calls forget: a crash in between leaves the org refused, and a rerun finishes", async () => {
    const orgId = await orgWithMemory();
    let forgetSeen = false;
    const recorded: [string, number, boolean][] = [];
    const crashing: typeof admin = (method, path, body) => {
      if (path === "/scopes/forget") {
        forgetSeen = true;
        return Promise.resolve(new Response("down", { status: 503 }));
      }
      return admin(method, path, body);
    };
    const run = await eraseRun(orgId, {
      admin: crashing,
      record: async (kind, scope, summary) => {
        recorded.push([kind, inScope(orgId), forgetSeen]);
        await recordMemoryErasure(db, { orgId, kind, scope, summary });
      },
    });
    await expect(eraseOrg(run)).rejects.toThrow(/forget → 503.*stays refused/);
    // The event was written while the scope was still full and before forget was sent.
    expect(recorded).toEqual([["erased", 9, false]]);
    expect(await memoryErased(db, orgId)).toBe(true);
    expect(inScope(orgId)).toBe(9);
    // Refused already, though memory still holds it.
    if (publisherFor === null) throw new Error("memory not configured");
    await approve(orgId, record("one", 2));
    const job = { orgId, precedentId: "one", version: 2 };
    expect(await syncPrecedent(job, { db, publisherFor })).toBe("org_erased");
    expect(await planJobRegistry(db, orgId)).toBeNull();

    const again = await eraseOrg(await eraseRun(orgId));
    expect(again).toMatchObject({ outcome: "erased", forgotten: 9 });
    expect(inScope(orgId)).toBe(0);
    expect((await memoryErasureEventsFor(db, orgId)).map((e) => e.kind)).toEqual([
      "erased",
      "erased",
      "forgotten",
    ]);
  });

  it("waits for a sync that is writing the org's memory before it records erased", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => {};
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const sync = db.transaction(async (tx) => {
      await lockOrgMemoryShared(tx, orgId);
      locked();
      await held;
    });
    await isLocked;
    let done = false;
    const erasure = recordMemoryErasure(db, {
      orgId,
      kind: "erased",
      scope: precedentScope(BASE, orgId),
      summary: {},
    }).then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(done).toBe(false);
    release();
    await sync;
    await erasure;
    expect(done).toBe(true);
  });

  it("holds off the erasure while a real sync is publishing, and refuses the sync after it (T1.55 review)", async () => {
    if (publisherFor === null) throw new Error("memory not configured");
    const real = publisherFor;
    const orgId = `org_${crypto.randomUUID()}`;
    await approve(orgId, record("slow"));
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let publishing: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      publishing = resolve;
    });
    // The publisher stalls mid-write, inside the sync's transaction and its shared lock.
    const slow = (org: string) => {
      const inner = real(org);
      return {
        publish: async (r: PrecedentRecord) => {
          publishing();
          await held;
          return inner.publish(r);
        },
        markWithdrawn: (id: string, version: number) => inner.markWithdrawn(id, version),
      } as unknown as ReturnType<typeof real>;
    };
    const sync = syncPrecedent(
      { orgId, precedentId: "slow", version: 1 },
      { db, publisherFor: slow },
    );
    await started;
    let erasedAt = 0;
    const erasure = recordMemoryErasure(db, {
      orgId,
      kind: "erased",
      scope: precedentScope(BASE, orgId),
      summary: {},
    }).then(() => {
      erasedAt = Date.now();
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(erasedAt).toBe(0);
    release();
    expect(await sync).toBe("activated");
    await erasure;
    expect(erasedAt).toBeGreaterThan(0);
    // The copy it wrote is in the scope the erasure then forgets; the next sync writes nothing.
    await approve(orgId, record("slow", 2));
    const writes = fake.writes;
    expect(
      await syncPrecedent({ orgId, precedentId: "slow", version: 2 }, { db, publisherFor }),
    ).toBe("org_erased");
    expect(fake.writes).toBe(writes);
  });

  it("refuses (exit 3) when Postgres and memory disagree about the org, unless --force (T1.55 review)", async () => {
    if (publisherFor === null) throw new Error("memory not configured");
    // The registry knows precedents, but memory holds nothing and the scope was never registered:
    // most likely the wrong memory context or base scope.
    const unsynced = `org_${crypto.randomUUID()}`;
    await approve(unsynced, record("one"));
    const lines: string[] = [];
    await expect(
      eraseOrg(await eraseRun(unsynced, { log: (l) => lines.push(l) })),
    ).rejects.toBeInstanceOf(EraseRefused);
    expect(lines).toContain(
      `  mismatch: the registry has 1 precedents for ${unsynced}, but memory holds nothing in its scope`,
    );
    expect(lines).toContain("  mismatch: the scope is absent, not registered");
    expect(await memoryErasureEventsFor(db, unsynced)).toEqual([]);

    // Memory holds a copy the registry here has never heard of: most likely the wrong database.
    const stranger = `org_${crypto.randomUUID()}`;
    await publisherFor(stranger).publish(record("one"));
    const res = await cli([stranger, "--yes", stranger], cliEnv());
    expect(res.status).toBe(3);
    expect(res.stdout).toContain(`database:     ${databaseTarget(url)}`);
    expect(res.stdout).toContain(`Agent Memory: ${fakeUrl}, context ctx`);
    expect(res.stdout).toContain("base scope:   rehearsal/precedents");
    expect(res.stdout).toContain("the registry in this database has no precedents");
    expect(res.stdout).not.toContain("pg@");
    expect(await memoryErasureEventsFor(db, stranger)).toEqual([]);
    expect(inScope(stranger)).toBe(3);

    // Tombstoned, but this database never recorded an erasure.
    const elsewhere = await orgWithMemory();
    expect((await admin("DELETE", `/scopes?path=${precedentScope(BASE, elsewhere)}`)).status).toBe(
      204,
    );
    await expect(eraseOrg(await eraseRun(elsewhere))).rejects.toThrow(/disagree/);

    // --force goes on.
    const forced = await cli([stranger, "--yes", stranger, "--force"], cliEnv());
    expect(forced.status).toBe(0);
    expect(forced.stdout).toContain("--force: going on anyway");
    expect(inScope(stranger)).toBe(0);
    expect((await memoryErasureEventsFor(db, stranger)).map((e) => e.kind)).toEqual([
      "erased",
      "forgotten",
    ]);
  }, 60_000);

  it("on a rerun after the tombstone, sends neither forget nor the tombstone again (T1.55 review)", async () => {
    const orgId = await orgWithMemory();
    expect((await eraseOrg(await eraseRun(orgId))).outcome).toBe("erased");
    const before = fake.requests.length;
    const lines: string[] = [];
    const again = await eraseOrg(await eraseRun(orgId, { log: (l) => lines.push(l) }));
    expect(again).toMatchObject({ outcome: "erased", forgotten: 0 });
    expect(again.listing.registered).toBe("tombstoned");
    const sent = fake.requests.slice(before).map((r) => `${r.method} ${r.path.split("?")[0]}`);
    expect(sent.filter((r) => r.endsWith("/scopes/forget") || r.startsWith("DELETE "))).toEqual([]);
    expect(lines).toContain(
      `${precedentScope(BASE, orgId)} was already tombstoned and nothing in it is live; nothing was sent`,
    );
    const events = await memoryErasureEventsFor(db, orgId);
    expect(events.map((e) => e.kind)).toEqual(["erased", "forgotten", "erased", "forgotten"]);
    expect(events[3]?.summary).toEqual({
      forgotten: 0,
      tombstoned: true,
      alreadyTombstoned: true,
      forgetSent: false,
    });
  });

  it("checks afterwards through recall too, not only the entities it listed (T1.55 review)", async () => {
    const orgId = await orgWithMemory();
    // A forget that leaves one copy behind which only recall finds.
    const leaky: typeof admin = async (method, path, body) => {
      const res = await admin(method, path, body);
      if (path === "/scopes/forget") {
        fake.seed(precedentScope(BASE, orgId), "precedent:late", "statement", "precedent late");
        fake.seed(precedentScope(BASE, orgId), "precedent:late", "appliesTo", AREA);
      }
      return res;
    };
    await expect(eraseOrg(await eraseRun(orgId, { admin: leaky }))).rejects.toThrow(
      /still has live attributes/,
    );
  });

  it("makes a promotion wait for an erasure holding the org's lock, then refuses it (T1.55 review)", async () => {
    const orgId = await orgWithMemory();
    const runId = await seedRunFor(orgId);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => {};
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // What recordMemoryErasure does, held open: the exclusive lock and the uncommitted event.
    const erasing = db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`rehearsal:org-memory:${orgId}`}, 0))`,
      );
      await tx.insert(schema.memoryErasureEvents).values({
        orgId,
        kind: "erased",
        scope: precedentScope(BASE, orgId),
        summary: {},
      });
      locked();
      await held;
    });
    await isLocked;
    const me = finance(orgId);
    const app = buildApp({
      webRoot: null,
      precedents: { db, boss, iam: fakeIam([me]), syncEnabled: true },
    });
    let answered = false;
    const promoting = app
      .inject({
        method: "POST",
        url: `/api/runs/${runId}/precedents`,
        headers: bearer(me),
        payload: {
          id: "raced",
          appliesTo: AREA,
          statement: "Refund a duplicate charge in full.",
          conditions: [],
          exceptions: [],
          effectiveFrom: "2026-10-01",
          effectiveUntil: null,
        },
      })
      .then((res) => {
        answered = true;
        return res;
      });
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Without the lock it would have read no event yet and stored a version that waits forever.
    expect(answered).toBe(false);
    release();
    await erasing;
    const res = await promoting;
    await app.close();
    expect([res.statusCode, res.json()]).toEqual([409, { error: "memory_erased" }]);
    expect((await loadRegistry(db, orgId)).entries.some((e) => e.id === "raced")).toBe(false);
  });

  async function seedRunFor(org: string) {
    const runId = `run_${crypto.randomUUID()}`;
    await db.insert(schema.runs).values({
      id: runId,
      orgId: org,
      planId: `plan_${crypto.randomUUID()}`,
      revision: 1,
      planHash: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
      approvalId: "grant_1",
      requestedBy: "user_fin",
      state: "completed",
    });
    return runId;
  }

  describe("a plan job queued before the erasure (T1.55 review)", () => {
    const worker = { authorization: "Bearer planner-secret" };
    const basis = {
      citations: [
        {
          id: "one",
          version: 1,
          digest: precedentDigest(record("one")),
          appliesTo: AREA,
          factIds: ["f1"],
          traceId: "t1",
        },
      ],
      epochs: { [AREA]: 1 },
    };

    it("is handed out and checked with memory off once the org is erased; one taken before fails and replans", async () => {
      const orgId = await orgWithMemory();
      const me = support(orgId, "user_1");
      const queue = { boss };
      const app = buildApp({
        webRoot: null,
        rehearse: {
          db,
          boss: queue.boss,
          iam: fakeIam([me]),
          plannerSecret: "planner-secret",
          precedentRegistry: (o) => planJobRegistry(db, o),
        },
      });
      const inject = (method: "GET" | "POST", path: string, payload?: object, h = worker) =>
        app.inject({ method, url: path, headers: h, ...(payload && { payload }) });
      const rehearse = async () =>
        (
          await inject(
            "POST",
            `/api/incidents/${INCIDENT.incident}/rehearse`,
            undefined,
            bearer(me),
          )
        ).json() as { rehearsalId: string; planId: string };
      const next = async () => {
        const res = await inject("POST", PLANNER_JOB_ROUTES.next);
        return { id: res.json().id as string, data: PlanJob.parse(res.json().data) };
      };
      const complete = (id: string, planId: string, withBasis: boolean) =>
        inject("POST", PLANNER_JOB_ROUTES.complete.replace(":id", id), {
          manifest: {
            ...billingManifest(planId),
            orgId,
            ...(withBasis && { precedentBasis: basis }),
          },
          summary: "8 refunds.",
        });

      // Both queued with the registry; the first is taken with it, before the erasure.
      const taken = await rehearse();
      const waiting = await rehearse();
      for (const id of [taken.rehearsalId, waiting.rehearsalId]) {
        expect(PlanJob.parse((await boss.getJobById("plan", id))?.data).precedents).toBeDefined();
      }
      const first = await next();
      expect(first.id).toBe(taken.rehearsalId);
      expect(first.data.precedents).toBeDefined();

      expect((await eraseOrg(await eraseRun(orgId))).outcome).toBe("erased");

      // Completed with the basis it recalled before: failed as org_erased, so the queue retries.
      const late = await complete(taken.rehearsalId, taken.planId, true);
      expect(late.statusCode).toBe(422);
      expect(await boss.getJobById("plan", taken.rehearsalId)).toMatchObject({
        state: "retry",
        output: { reason: "org_erased" },
      });

      // From now on both are handed out without memory, and succeed without a basis.
      const planOf = new Map([
        [waiting.rehearsalId, waiting],
        [taken.rehearsalId, taken],
      ]);
      for (let i = 0; i < 2; i++) {
        const job = await next();
        const want = planOf.get(job.id);
        if (!want) throw new Error(`unexpected job ${job.id}`);
        planOf.delete(job.id);
        expect(job.data.precedents).toBeUndefined();
        expect((await complete(job.id, want.planId, false)).statusCode).toBe(201);
      }
      const status = await inject(
        "GET",
        `/api/rehearsals/${taken.rehearsalId}`,
        undefined,
        bearer(me),
      );
      expect(status.json()).toMatchObject({ state: "stored" });
      // A worker that recalled anyway can't store a basis for the erased org.
      const again = await rehearse();
      const job = await next();
      expect(job.id).toBe(again.rehearsalId);
      expect((await complete(job.id, again.planId, true)).statusCode).toBe(422);
      await boss.cancel("plan", again.rehearsalId);
      await app.close();
    });

    it("recovers the same job after its normal retry is spent, without granting another recovery", async () => {
      const orgId = await orgWithMemory();
      const me = support(orgId, "user_1");
      const app = buildApp({
        webRoot: null,
        rehearse: {
          db,
          boss,
          iam: fakeIam([me]),
          plannerSecret: "planner-secret",
          precedentRegistry: (o) => planJobRegistry(db, o),
        },
      });
      const queued = await app.inject({
        method: "POST",
        url: `/api/incidents/${INCIDENT.incident}/rehearse`,
        headers: bearer(me),
      });
      const { rehearsalId, planId } = queued.json();
      const next = () =>
        app.inject({ method: "POST", url: PLANNER_JOB_ROUTES.next, headers: worker });
      expect((await next()).json().id).toBe(rehearsalId);
      await boss.fail("plan", rehearsalId, { reason: "planner_error" });
      expect((await next()).json().id).toBe(rehearsalId);
      expect(await boss.getJobById("plan", rehearsalId)).toMatchObject({
        retryCount: 1,
        retryLimit: 1,
      });
      await eraseOrg(await eraseRun(orgId));
      const complete = (withBasis: boolean) =>
        app.inject({
          method: "POST",
          url: PLANNER_JOB_ROUTES.complete.replace(":id", rehearsalId),
          headers: worker,
          payload: {
            manifest: {
              ...billingManifest(planId),
              orgId,
              ...(withBasis && { precedentBasis: basis }),
            },
            summary: "8 refunds.",
          },
        });
      expect((await complete(true)).statusCode).toBe(422);
      expect((await loadPlan(db, orgId, planId, 1)).kind).toBe("not_found");
      expect(await boss.getJobById("plan", rehearsalId)).toMatchObject({
        state: "retry",
        retryLimit: 2,
      });
      const recovered = await next();
      expect(recovered.json().id).toBe(rehearsalId);
      expect(PlanJob.parse(recovered.json().data).precedents).toBeUndefined();
      expect((await complete(false)).statusCode).toBe(201);
      expect(await boss.getJobById("plan", rehearsalId)).toMatchObject({
        state: "completed",
        retryCount: 2,
      });

      // A worker ignoring its memory-free payload must fail normally, not replenish retries.
      const bad = await boss.send(
        "plan",
        {
          orgId,
          planId: `plan_${crypto.randomUUID()}`,
          incidentId: INCIDENT.incident,
          requestedBy: me.userId,
        },
        { retryLimit: 0 },
      );
      expect((await next()).json().id).toBe(bad);
      const storedJob = await boss.getJobById("plan", bad as string);
      const data = PlanJob.parse(storedJob?.data);
      const rejected = await app.inject({
        method: "POST",
        url: PLANNER_JOB_ROUTES.complete.replace(":id", bad as string),
        headers: worker,
        payload: {
          manifest: { ...billingManifest(data.planId), orgId, precedentBasis: basis },
          summary: "bad",
        },
      });
      expect(rejected.statusCode).toBe(422);
      expect(await boss.getJobById("plan", bad as string)).toMatchObject({
        state: "failed",
        retryLimit: 0,
      });
      await app.close();
    });

    it("a repair for the erased org is queued without memory too", async () => {
      const orgId = await orgWithMemory();
      const me = support(orgId, "user_1");
      const manifest: PlanManifest = {
        ...billingManifest(`plan_${crypto.randomUUID()}`),
        orgId,
      };
      await storePlan(db, manifest);
      const hash = planHash(manifest);
      const runId = `run_${crypto.randomUUID()}`;
      await db.insert(schema.runs).values({
        id: runId,
        orgId,
        planId: manifest.planId,
        revision: 1,
        planHash: hash,
        approvalId: "grant_1",
        requestedBy: "user_1",
        state: "partial",
      });
      const journal = new PgJournal(db, orgId);
      const receipt = (
        actionId: string,
        outcome: Receipt["outcome"],
        holdReason: Receipt["holdReason"] = null,
      ): Receipt => ({
        id: `rcpt_${crypto.randomUUID()}`,
        actionId,
        planHash: hash,
        approvalId: "grant_1",
        outcome,
        providerRef: null,
        observedEffect: {},
        protection: "native_guard_with_documented_limits",
        holdReason,
        limitations: [],
        recordedAt: new Date().toISOString(),
      });
      for (const r of [
        receipt("refund_001", "held", {
          kind: "query_membership_changed",
          queryObservationId: "q_charges_001",
          added: ["ch_fixture_001_dup"],
          removed: [],
        }),
        receipt("patch_001", "confirmed"),
        receipt("note_001", "skipped_dependency", {
          kind: "predecessor_not_confirmed",
          stepId: "refund_001",
        }),
        receipt("refund_002", "confirmed"),
        receipt("patch_002", "confirmed"),
        receipt("note_002", "confirmed"),
      ]) {
        await journal.recordReceipt(r);
      }
      const queue = { boss };
      const repair = async () => {
        const app = buildApp({
          webRoot: null,
          rehearse: {
            db,
            boss: queue.boss,
            iam: fakeIam([me]),
            precedentRegistry: (o) => planJobRegistry(db, o),
            refreshPlanning: async (_: string, records: { id: string }[]) =>
              records.map((r) => r.id),
          },
        });
        const res = await app.inject({
          method: "POST",
          url: `/api/plans/${manifest.planId}/repair`,
          headers: bearer(me),
          payload: { runId, revision: 1, planHash: hash },
        });
        await app.close();
        return res;
      };
      // Before the erasure the repair job carries the registry; after it, not.
      const before = await repair();
      expect(before.statusCode).toBe(202);
      expect(
        PlanJob.parse((await boss.getJobById("plan", before.json().rehearsalId))?.data).precedents,
      ).toBeDefined();
      expect((await eraseOrg(await eraseRun(orgId))).outcome).toBe("erased");
      const after = await repair();
      expect(after.statusCode).toBe(202);
      const job = PlanJob.parse((await boss.getJobById("plan", after.json().rehearsalId))?.data);
      expect(job.repair).toMatchObject({ basePlanHash: hash, runId });
      expect(job.precedents).toBeUndefined();
    });
  });

  describe("after erasure, everything refuses the org; planning and execution go on", () => {
    let orgId = "";
    let other = "";
    const deps = (me: ReturnType<typeof finance>) => ({
      precedents: {
        db,
        boss,
        iam: fakeIam([me]),
        syncEnabled: true,
        similar,
      },
    });
    async function seedRun(org: string) {
      const runId = `run_${crypto.randomUUID()}`;
      await db.insert(schema.runs).values({
        id: runId,
        orgId: org,
        planId: `plan_${crypto.randomUUID()}`,
        revision: 1,
        planHash: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
        approvalId: "grant_1",
        requestedBy: "user_fin",
        state: "completed",
      });
      return runId;
    }
    async function post(org: string, path: string, payload: object) {
      const me = finance(org);
      const app = buildApp({ webRoot: null, ...deps(me) });
      try {
        return await app.inject({ method: "POST", url: path, headers: bearer(me), payload });
      } finally {
        await app.close();
      }
    }

    beforeAll(async () => {
      orgId = await orgWithMemory();
      other = await orgWithMemory();
      const out = await eraseOrg(await eraseRun(orgId));
      expect(out.outcome).toBe("erased");
    });

    it("the API's sync writes nothing for it and completes, for a publish and a withdrawal", async () => {
      if (publisherFor === null) throw new Error("memory not configured");
      const writes = fake.writes;
      await approve(orgId, record("two", 2));
      expect(
        await syncPrecedent({ orgId, precedentId: "two", version: 2 }, { db, publisherFor }),
      ).toBe("org_erased");
      await recordPrecedentEvent(db, { orgId, precedentId: "one", version: 1, kind: "withdrawn" });
      expect(
        await syncPrecedent(
          { orgId, precedentId: "one", version: 1, kind: "withdraw" },
          { db, publisherFor },
        ),
      ).toBe("org_erased");
      expect(fake.writes).toBe(writes);
      // v2 waits: the registry is still what Postgres says, and nothing activated it.
      const { entries } = await loadRegistry(db, orgId);
      expect(entries.find((e) => e.id === "two" && e.version === 2)?.status).toBe("waiting");
    });

    it("the plan job goes out with memory off: no registry, so no recall and no precedent basis", async () => {
      expect(await planJobRegistry(db, orgId)).toBeNull();
      expect((await planJobRegistry(db, other))?.active.size).toBe(2);

      const sent: unknown[] = [];
      const queue = {
        send: async (_: string, data: unknown) => {
          sent.push(data);
          return "11111111-1111-4111-8111-111111111111";
        },
      } as unknown as PgBoss;
      for (const org of [orgId, other]) {
        const person = support(org, "user_1");
        const app = buildApp({
          webRoot: null,
          rehearse: {
            // The route's own reads (a filed incident) find nothing; the registry is real.
            db: { select: () => ({ from: () => ({ where: async () => [] }) }) } as unknown as Db,
            boss: queue,
            iam: fakeIam([person]),
            precedentRegistry: (o) => planJobRegistry(db, o),
          },
        });
        const res = await app.inject({
          method: "POST",
          url: `/api/incidents/${INCIDENT.incident}/rehearse`,
          headers: bearer(person),
        });
        await app.close();
        expect(res.statusCode).toBe(202);
      }
      const [erasedJob, otherJob] = sent.map((d) => PlanJob.parse(d));
      expect(erasedJob?.precedents).toBeUndefined();
      expect(otherJob?.precedents?.active.map((a) => a.id).sort()).toEqual(["one", "two"]);
      // A plan without a basis is what that job allows, and approval passes it.
      const manifest = { orgId, precedentBasis: undefined };
      expect(checkJobBasis(manifest as never, erasedJob as PlanJob)).toBeNull();
      expect(await precedentCheck(db, manifest)).toEqual({ ok: true });
    });

    it("a plan that already cited its precedents still checks against Postgres", async () => {
      const two = record("two");
      const cited = {
        orgId,
        precedentBasis: {
          citations: [
            {
              id: "two",
              version: 1,
              digest: precedentDigest(two),
              appliesTo: AREA,
              factIds: ["f1"],
              traceId: "t1",
            },
          ],
          epochs: { [AREA]: 2 },
        },
      };
      // "one" was withdrawn above, so the area's epoch moved: held, by the registry alone.
      expect(await precedentCheck(db, cited)).toMatchObject({
        ok: false,
        holds: [{ appliesTo: AREA, reason: "epoch_changed" }],
      });
      const now = (await loadRegistry(db, orgId)).snapshot.epochs.get(AREA) ?? 0;
      expect(
        await precedentCheck(db, {
          ...cited,
          precedentBasis: { ...cited.precedentBasis, epochs: { [AREA]: now } },
        }),
      ).toEqual({ ok: true });
    });

    it("the similar-precedents hint answers off without recalling; another org's still recalls", async () => {
      const before = fake.requests.length;
      const draft = { appliesTo: AREA, statement: "Refund a duplicate charge in full." };
      const erased = await post(
        orgId,
        `/api/runs/${await seedRun(orgId)}/precedents/similar`,
        draft,
      );
      expect([erased.statusCode, erased.json()]).toEqual([200, { status: "off", similar: [] }]);
      expect(fake.requests.length).toBe(before);
      const live = await post(other, `/api/runs/${await seedRun(other)}/precedents/similar`, draft);
      expect(live.json().status).toBe("ok");
    });

    it("refuses a new promotion (409 memory_erased) and records nothing; another org promotes", async () => {
      const body = {
        id: "three",
        appliesTo: AREA,
        statement: "Refund a duplicate charge in full.",
        conditions: [],
        exceptions: [],
        effectiveFrom: "2026-10-01",
        effectiveUntil: null,
      };
      const before = (await loadRegistry(db, orgId)).entries.length;
      const res = await post(orgId, `/api/runs/${await seedRun(orgId)}/precedents`, body);
      expect([res.statusCode, res.json()]).toEqual([409, { error: "memory_erased" }]);
      expect((await loadRegistry(db, orgId)).entries).toHaveLength(before);
      expect(
        (await post(other, `/api/runs/${await seedRun(other)}/precedents`, body)).statusCode,
      ).toBe(201);
    });

    it("the drift check refuses it without reading memory, and checks the others", async () => {
      fake.keys.set("sp-read-key", { read: [""], write: [] });
      const reader = new AgentMemoryClient({ ...memory, apiKey: "sp-read-key" });
      const scopes: string[] = [];
      const lines: string[] = [];
      const result = await runDrift({
        db,
        orgs: [orgId, other],
        readerFor: (org) => {
          scopes.push(org);
          return new AgentMemoryPrecedents(reader, { scope: precedentScope(BASE, org), k: 50 });
        },
        enqueue: async () => {
          throw new Error("nothing may be queued for an erased org");
        },
        log: (l) => lines.push(l),
      });
      expect(result.erased).toEqual([orgId]);
      expect(scopes).toEqual([other]);
      expect(lines[0]).toBe(
        `${orgId}: refused: its Agent Memory was erased (pnpm memory:erase-org)`,
      );
    });
  });
});
