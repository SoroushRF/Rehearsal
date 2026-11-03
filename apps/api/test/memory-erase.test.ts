import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import {
  approvePrecedent,
  createDb,
  type Db,
  loadRegistry,
  lockOrgMemoryShared,
  memoryErased,
  memoryErasureEventsFor,
  migrateDb,
  type PgBoss,
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
import { PlanJob } from "@rehearsal/providers";
import { INCIDENT } from "@rehearsal/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeAgentMemory } from "../../../packages/memory/test/fake-agent-memory";
import { runDrift } from "../../../scripts/memory/drift-run";
import { type EraseOrgRun, eraseOrg } from "../../../scripts/memory/erase-run";
import { adminFor } from "../../../scripts/memory/keys-run";
import { buildApp } from "../src/app";
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
  const url = process.env.DATABASE_URL ?? "postgres://rehearsal:rehearsal@localhost:5432/rehearsal";
  const db = createDb(url);
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
    await migrateDb(db);
    boss = await startQueue(url);
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
