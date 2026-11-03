import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  approvePrecedent,
  createDb,
  enqueuePrecedentSync,
  loadRegistry,
  migrateDb,
  type PgBoss,
  PRECEDENT_QUEUE,
  type PrecedentSyncJob,
  precedentSyncPending,
  recordPrecedentEvent,
  startPrecedentSender,
  startQueue,
} from "@rehearsal/db";
import {
  AgentMemoryClient,
  AgentMemoryPrecedents,
  type DriftReader,
  type PrecedentRecord,
  precedentDigest,
  precedentScope,
} from "@rehearsal/memory";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeAgentMemory } from "../../../packages/memory/test/fake-agent-memory";
import { driftCredentialViolations, runDrift } from "../../../scripts/memory/drift-run";
import { publisherFromEnv, syncPrecedent } from "../src/precedent-sync";

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

/** `pnpm memory:drift` itself, with exactly `env` (plus PATH): for usage and startup refusals. */
function cli(args: string[], env: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, ["--import", "tsx", "scripts/memory/drift.ts", ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "", ...env },
    encoding: "utf8",
  });
  return { status: res.status, stderr: res.stderr };
}

describe("memory drift check credentials and usage", () => {
  it("runs with a read key and DATABASE_URL, and refuses any key that could write memory", () => {
    const ok = {
      DATABASE_URL: "postgres://x",
      SURREAL_AGENT_MEMORY_URL: "http://fake/",
      SURREAL_AGENT_MEMORY_CONTEXT: "ctx",
      SURREAL_AGENT_MEMORY_READ_KEY: "sp-read-key",
    };
    expect(driftCredentialViolations(ok)).toEqual([]);
    expect(
      driftCredentialViolations({
        ...ok,
        SURREAL_AGENT_MEMORY_WRITE_KEY: "w",
        SURREAL_AGENT_MEMORY_ADMIN_KEY: "a",
        SURREAL_AGENT_MEMORY_KEY: "legacy",
        ANTHROPIC_API_KEY: "m",
        EXECUTOR_WORKER_SECRET: "e",
      }),
    ).toEqual([
      "SURREAL_AGENT_MEMORY_WRITE_KEY",
      "SURREAL_AGENT_MEMORY_ADMIN_KEY",
      "SURREAL_AGENT_MEMORY_KEY",
      "ANTHROPIC_API_KEY",
      "EXECUTOR_WORKER_SECRET",
    ]);
  });

  it("exits 2 on bad usage and 3 on a refused key or missing settings", () => {
    for (const args of [[], ["-x", "org_1"], ["org_1", "--fix"], ["org_1", "--activate-waiting"]]) {
      expect(cli(args).status).toBe(2);
    }
    expect(cli(["org_1"], { SURREAL_AGENT_MEMORY_ADMIN_KEY: "a" })).toMatchObject({
      status: 3,
      stderr: expect.stringContaining("refusing to run with SURREAL_AGENT_MEMORY_ADMIN_KEY"),
    });
    expect(cli(["org_1"]).status).toBe(3);
  }, 30_000);
});

// `pnpm memory:drift --repair` end to end on real Postgres and pg-boss, with the fake Agent Memory:
// the check only reads memory and queues the API's own sync jobs, and those jobs, run by the
// API's sync handler, are what bring memory back in line with the registry (T1.53).
describe.skipIf(!process.env.DB_TESTS)("memory drift check and repair (real Postgres)", () => {
  const url = process.env.DATABASE_URL ?? "postgres://rehearsal:rehearsal@localhost:5432/rehearsal";
  const db = createDb(url);
  const fake = new FakeAgentMemory();
  fake.keys.set("sp-read-key", { read: [""], write: [] });
  const env = {
    SURREAL_AGENT_MEMORY_URL: "http://fake/",
    SURREAL_AGENT_MEMORY_CONTEXT: "ctx",
    SURREAL_AGENT_MEMORY_WRITE_KEY: "sp-test-key",
  };
  const publisherFor = publisherFromEnv(env, { fetch: fake.fetch });
  const reader = new AgentMemoryClient({
    url: "http://fake/",
    context: "ctx",
    apiKey: "sp-read-key",
    fetch: fake.fetch,
  });
  const readerFor = (orgId: string) =>
    new AgentMemoryPrecedents(reader, {
      scope: precedentScope(BASE, orgId),
      k: 50,
      clock: { now: () => new Date("2026-10-24T12:00:00Z") },
    });
  /** An hour on: everything approved in the test is past the grace period. */
  const later = () => new Date(Date.now() + 60 * 60_000);
  let boss: PgBoss;

  beforeAll(async () => {
    await migrateDb(db);
    boss = await startQueue(url);
  });
  afterAll(async () => {
    await boss?.stop({ graceful: false });
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
  /** Approve and run the sync job, as the API does: published, read back, then active. */
  async function synced(orgId: string, r: PrecedentRecord) {
    await approve(orgId, r);
    if (publisherFor === null) throw new Error("memory not configured");
    const job = { orgId, precedentId: r.id, version: r.version };
    expect(await syncPrecedent(job, { db, publisherFor })).toBe("activated");
  }
  const event = (orgId: string, id: string, version: number, kind: "activated" | "withdrawn") =>
    recordPrecedentEvent(db, { orgId, precedentId: id, version, kind });
  /** What `pnpm memory:drift --repair` does for each job: skip it if already pending, else send. */
  const enqueue = (job: PrecedentSyncJob) =>
    db.transaction(async (tx) => {
      if (await precedentSyncPending(tx, job)) return "already_queued" as const;
      await enqueuePrecedentSync(boss, tx, job);
      return "queued" as const;
    });
  const queuedFor = async (orgId: string) =>
    (
      await db.execute<{ data: PrecedentSyncJob }>(
        sql`select data from pgboss.job where name = ${PRECEDENT_QUEUE} and data->>'orgId' = ${orgId} order by data->>'precedentId', data->>'kind'`,
      )
    ).rows.map((r) => r.data);
  const findingLines = (lines: string[]) => lines.filter((l) => /^ {2}\S/.test(l));

  it("reports each kind of drift, queues safe repairs once, activations only on request, and the API's sync repairs them", async () => {
    if (publisherFor === null) throw new Error("memory not configured");
    const orgId = `org_${crypto.randomUUID()}`;
    // In line: active v1, stored v1.
    await synced(orgId, record("in-line"));
    // Missing: v1 activated without a copy (memory lost it).
    await approve(orgId, record("missing"));
    await event(orgId, "missing", 1, "activated");
    // Stale: v1 synced, then v2 activated without its copy.
    await synced(orgId, record("stale"));
    await approve(orgId, record("stale", 2));
    await event(orgId, "stale", 2, "activated");
    // Unmarked withdrawal: v1 withdrawn, its withdraw job never ran.
    await synced(orgId, record("withdrawn"));
    await event(orgId, "withdrawn", 1, "withdrawn");
    // The known gap: v1 withdrawn, v2 approved, and v2's sync failed for good.
    await synced(orgId, record("gap"));
    await event(orgId, "gap", 1, "withdrawn");
    await approve(orgId, record("gap", 2));
    // Unknown: a copy in the org's scope the registry never approved.
    await publisherFor(orgId).publish(record("planted"));

    const writes = fake.writes;
    const repair = async (activateWaiting = false) => {
      const lines: string[] = [];
      const result = await runDrift({
        db,
        orgs: [orgId],
        readerFor,
        enqueue,
        activateWaiting,
        now: later,
        log: (l) => lines.push(l),
      });
      return { result, lines };
    };

    // --repair: the safe repairs are queued; the gap's publish would activate v2, so it waits.
    const first = await repair();
    expect(first.result).toEqual({
      findings: 5,
      queued: 3,
      alreadyQueued: 0,
      notActivated: 1,
      noRegistry: [],
    });
    expect(fake.writes).toBe(writes);
    expect(findingLines(first.lines)).toEqual([
      "  unmarked_withdrawal gap: memory holds v1; registry has v2 approved 60 min ago, never activated; repair: publish v2 (activates it) (a withdraw job does nothing once v2 is approved; its publish replaces the copy)",
      "  missing missing: memory holds nothing; registry has v1 active; repair: publish v1",
      "  stale stale: memory holds v1; registry has v2 active; repair: publish v2",
      "  unmarked_withdrawal withdrawn: memory holds v1; registry has v1 withdrawn; repair: withdraw v1",
      "  unknown planted: memory holds v1; registry has never approved; repair: none (reported only; the check never deletes)",
    ]);
    expect(first.lines).toContain("    not queued: it activates v2; pass --activate-waiting");

    // --repair again before the worker drains the queue: nothing is queued twice.
    const second = await repair();
    expect(second.result).toMatchObject({ queued: 0, alreadyQueued: 3, notActivated: 1 });
    expect(second.lines).toContain("    already queued publish v1");
    expect(await queuedFor(orgId)).toEqual([
      { orgId, precedentId: "missing", version: 1, kind: "publish" },
      { orgId, precedentId: "stale", version: 2, kind: "publish" },
      { orgId, precedentId: "withdrawn", version: 1, kind: "withdraw" },
    ]);
    expect((await loadRegistry(db, orgId)).snapshot.active.get("gap")).toBeUndefined();

    // --repair --activate-waiting: the gap's publish too, once.
    const third = await repair(true);
    expect(third.result).toMatchObject({ queued: 1, alreadyQueued: 3, notActivated: 0 });
    expect(await repair(true)).toMatchObject({ result: { queued: 0, alreadyQueued: 4 } });
    const queued = await queuedFor(orgId);
    expect(queued).toHaveLength(4);
    expect(queued[0]).toEqual({ orgId, precedentId: "gap", version: 2, kind: "publish" });
    expect(fake.writes).toBe(writes);

    // The API's sync handler runs the queued jobs: the only writer.
    const results = [];
    for (const data of queued) results.push(await syncPrecedent(data, { db, publisherFor }));
    expect(results).toEqual(["activated", "already_active", "already_active", "marked_withdrawn"]);
    expect((await loadRegistry(db, orgId)).snapshot.active.get("gap")?.version).toBe(2);

    const after: string[] = [];
    expect(
      await runDrift({ db, orgs: [orgId], readerFor, now: later, log: (l) => after.push(l) }),
    ).toMatchObject({ findings: 1, queued: 0 });
    expect(findingLines(after)).toEqual([
      "  unknown planted: memory holds v1; registry has never approved; repair: none (reported only; the check never deletes)",
    ]);
  });

  it("leaves out a version approved within the grace period: its own sync may be running", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    await approve(orgId, record("fresh"));
    const lines: string[] = [];
    const run = await runDrift({
      db,
      orgs: [orgId],
      readerFor,
      enqueue,
      log: (l) => lines.push(l),
    });
    expect(run).toMatchObject({ findings: 0, queued: 0, noRegistry: [] });
    expect(lines).toContain(
      "  in flight fresh: a version approved under 10 min ago; its sync may still be running",
    );
    // An hour on, its sync has clearly failed: reported as waiting, and not queued without the flag.
    expect(
      await runDrift({ db, orgs: [orgId], readerFor, enqueue, now: later, log: () => {} }),
    ).toMatchObject({ findings: 1, queued: 0, notActivated: 1 });
  });

  it("drops a finding whose registry changed while memory was being read", async () => {
    if (publisherFor === null) throw new Error("memory not configured");
    const orgId = `org_${crypto.randomUUID()}`;
    await approve(orgId, record("racing"));
    // Its sync completes between the check's first registry read and its memory read.
    let raced = false;
    const racing = (id: string): DriftReader => {
      const inner = readerFor(id);
      return {
        scope: inner.scope,
        recall: (q) => inner.recall(q),
        async read(precedentId) {
          if (!raced) {
            raced = true;
            const job = { orgId, precedentId: "racing", version: 1 };
            await syncPrecedent(job, { db, publisherFor });
          }
          return inner.read(precedentId);
        },
      };
    };
    const lines: string[] = [];
    const run = await runDrift({
      db,
      orgs: [orgId],
      readerFor: racing,
      enqueue,
      now: later,
      log: (l) => lines.push(l),
    });
    expect(run).toMatchObject({ findings: 0, queued: 0, notActivated: 0 });
    expect(lines).toContain("  changed racing: the registry moved mid-check; run again");
    expect(
      await runDrift({ db, orgs: [orgId], readerFor, now: later, log: () => {} }),
    ).toMatchObject({ findings: 0 });
  });

  it("sends repairs through a pg-boss that only sends: no queue set up, no maintenance", async () => {
    const sender = await startPrecedentSender(url);
    const orgId = `org_${crypto.randomUUID()}`;
    const job = { orgId, precedentId: "p", version: 1, kind: "publish" as const };
    try {
      await db.transaction((tx) => enqueuePrecedentSync(sender, tx, job));
    } finally {
      await sender.stop({ graceful: false });
    }
    expect(await queuedFor(orgId)).toEqual([job]);
  });

  it("warns about an org with no registry: most likely a mistyped org ID", async () => {
    const lines: string[] = [];
    const orgId = `org_${crypto.randomUUID()}`;
    expect(await runDrift({ db, orgs: [orgId], readerFor, log: (l) => lines.push(l) })).toEqual({
      findings: 0,
      queued: 0,
      alreadyQueued: 0,
      notActivated: 0,
      noRegistry: [orgId],
    });
    expect(lines).toEqual([
      `${orgId} (${precedentScope(BASE, orgId)}): 0 checked, 0 drift`,
      `  warning: no registry for ${orgId}; check the org id`,
    ]);
  });
});
