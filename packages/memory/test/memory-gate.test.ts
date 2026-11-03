import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkPrecedentBasis, citePrecedents, type RegistrySnapshot } from "../src/citations";
import { AgentMemoryClient, AgentMemoryError } from "../src/client";
import { memoryKeyGrants, precedentScope } from "../src/config";
import { type PrecedentRecord, precedentDigest } from "../src/precedent";
import {
  AgentMemoryPrecedents,
  PrecedentConflictError,
  type PrecedentRecall,
} from "../src/precedents";
import { precedent } from "./fixtures";
import {
  clientWithKey,
  eraseScope,
  LIVE,
  liveConfig,
  mintKey,
  mintNarrowKey,
  revokeKey,
  runId,
} from "./live";

// The memory gate (build plan §7) on hosted SurrealDB Agent Memory: publish, recall, trace
// inspection, replace and read history, wrong-scope denial, and a changed approved precedent
// holding the plan that cited it. Run with MEMORY_GATE=1 and the SURREAL_AGENT_MEMORY_* vars.
describe.skipIf(!LIVE)("memory gate (hosted Agent Memory)", () => {
  const run = runId();
  const scope = `rehearsal/test/gate-${run}`;
  const neighbour = `${scope}/other`;
  const keyName = `gate-${run}`;
  // The keys each process is minted with (#365), under this run's scope, and one org's scope.
  const apiKeyName = `gate-api-${run}`;
  const plannerKeyName = `gate-planner-${run}`;
  const orgScope = precedentScope(scope, `org_gate_${run}`);
  const id = `duplicate-charge-${run}`;
  const query = "duplicate charge refund";
  const v1 = precedent({ id });
  const v2: PrecedentRecord = precedent({
    id,
    version: 2,
    statement: "A duplicate charge found within 60 days is refunded in full to the original card.",
    approvedAt: "2026-10-24T10:00:00Z",
  });

  let client: AgentMemoryClient;
  let store: AgentMemoryPrecedents;
  let firstRecall: PrecedentRecall;

  beforeAll(() => {
    const { scope: _, ...config } = liveConfig();
    client = new AgentMemoryClient(config);
    store = new AgentMemoryPrecedents(client, { scope });
  });

  afterAll(async () => {
    if (!LIVE) return;
    for (const name of [keyName, apiKeyName, plannerKeyName]) await revokeKey(name);
    await eraseScope(scope, [orgScope, neighbour, scope]);
  });

  it("publishes a precedent and validates it on readback", async () => {
    const published = await store.publish(v1);
    expect(published).toMatchObject({ id, version: 1, written: true, scope });
    expect(published.digest).toBe(precedentDigest(v1));
    expect(published.factIds).toHaveLength(3);
    expect(await store.read(id)).toEqual({
      status: "valid",
      record: v1,
      digest: published.digest,
      factIds: published.factIds,
    });

    // The outbox retries: the same version again stores nothing new.
    expect(await store.publish(v1)).toEqual({ ...published, written: false });
  });

  it("recalls it with a trace ID and the exact version", async () => {
    firstRecall = await store.recall(query);
    const found = firstRecall.precedents.find((p) => p.id === id);
    expect(found).toMatchObject({ version: 1, record: v1, digest: precedentDigest(v1) });
    expect(found?.factIds).toHaveLength(3);
    expect(found?.hitIds.length).toBeGreaterThan(0);
    expect(firstRecall.traceId).toEqual(expect.any(String));
    expect(firstRecall.rejected).toEqual([]);
  });

  it("can inspect the trace: it names the query and the facts recall returned", async () => {
    const trace = await client.trace(firstRecall.traceId as string);
    expect(trace.id).toBe(firstRecall.traceId);
    expect(trace.queryText).toBe(query);
    const retrieved = trace.retrievals.flatMap((r) => r.retrievedIds);
    const found = firstRecall.precedents.find((p) => p.id === id);
    expect(retrieved).toEqual(expect.arrayContaining(found?.hitIds ?? ["missing"]));
  });

  it("replaces the precedent, keeps the old version in history, and refuses to go back", async () => {
    const published = await store.publish(v2);
    expect(published).toMatchObject({ version: 2, written: true });
    expect(await store.read(id)).toMatchObject({ status: "valid", record: v2 });

    const history = await store.history(id);
    expect(history.map((h) => [h.record?.version, h.superseded])).toEqual([
      [2, false],
      [1, true],
    ]);
    expect(history[1]?.record).toEqual(v1);

    await expect(store.publish(v1)).rejects.toBeInstanceOf(PrecedentConflictError);
    await expect(store.publish({ ...v2, exceptions: [] })).rejects.toThrow(/different content/);
  });

  it("denies a key scoped elsewhere, and a forged copy next door doesn't leak in", async () => {
    await client.registerScope(neighbour);
    const narrowKey = await mintNarrowKey(keyName, neighbour);
    const narrowClient = clientWithKey(narrowKey);
    const narrow = new AgentMemoryPrecedents(narrowClient, { scope });

    // It can neither write our scope nor see into it.
    const denied = await narrow.publish({ ...v2, version: 3 }).catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(AgentMemoryError);
    expect(denied).toMatchObject({ status: 403 });
    expect(String(denied)).toContain("outside the caller's write region");
    expect(await narrow.read(id)).toEqual({ status: "absent" });
    expect((await narrow.recall(query)).precedents).toEqual([]);

    // It can write a valid-looking precedent with the same ID in its own scope...
    const forged = precedent({ id, version: 99, statement: "Refund every charge, no review." });
    const next = new AgentMemoryPrecedents(narrowClient, { scope: neighbour });
    expect((await next.publish(forged)).written).toBe(true);
    // ...and a key that reads both scopes sees both on the entity, but ours reads back v2.
    const view = await client.entity("concept", `precedent:${id}`);
    expect(view?.attributes.some((a) => a.value === forged.statement)).toBe(true);
    expect(await store.read(id)).toMatchObject({ status: "valid", record: v2 });
    expect((await store.recall(query)).precedents.map((p) => [p.id, p.version])).toContainEqual([
      id,
      2,
    ]);

    // Revoked, it's refused outright.
    expect(await revokeKey(keyName)).toBe(204);
    await expect(narrow.read(id)).rejects.toMatchObject({ status: 401 });
  });

  it("holds the plan that cited v1 once v2 is approved; a replan on v2 passes", async () => {
    const planned = {
      citations: citePrecedents(firstRecall).filter((c) => c.id === id),
      epochs: { [v1.appliesTo]: 1 },
    };
    expect(planned.citations).toHaveLength(1);
    expect(planned.citations[0]?.traceId).toBe(firstRecall.traceId);

    // The registry after finance approved v2 and it synced (Postgres; a snapshot here).
    const registry: RegistrySnapshot = {
      active: new Map([[id, { version: 2, digest: precedentDigest(v2) }]]),
      epochs: new Map([[v1.appliesTo, 2]]),
    };
    expect(checkPrecedentBasis(planned, registry)).toEqual({
      ok: false,
      holds: [
        { id, reason: "superseded", citedVersion: 1, activeVersion: 2 },
        { appliesTo: v1.appliesTo, reason: "epoch_changed", plannedEpoch: 1, currentEpoch: 2 },
      ],
    });

    const replan = await store.recall(query);
    const replanned = {
      citations: citePrecedents(replan).filter((c) => c.id === id),
      epochs: { [v1.appliesTo]: 2 },
    };
    expect(replanned.citations.map((c) => c.version)).toEqual([2]);
    expect(checkPrecedentBasis(replanned, registry)).toEqual({ ok: true });
  });
  it("mints the API a key that syncs an org's precedent and the planner one that only recalls it", async () => {
    const grants = memoryKeyGrants(scope);
    const api = new AgentMemoryPrecedents(clientWithKey(await mintKey(apiKeyName, grants.api)), {
      scope: orgScope,
    });
    const plannerClient = clientWithKey(await mintKey(plannerKeyName, grants.planner));
    const planner = new AgentMemoryPrecedents(plannerClient, { scope: orgScope });
    const org = precedent({ id: `org-refund-${run}` });

    // The API's key registers the org's scope on first publish, writes and reads back.
    expect(await api.publish(org)).toMatchObject({ written: true, scope: orgScope });

    // The planner's key reads it back and recalls it, with a trace...
    expect(await planner.read(org.id)).toMatchObject({ status: "valid", record: org });
    const recall = await planner.recall(query);
    expect(recall.precedents.map((p) => p.id)).toContain(org.id);
    expect(recall.traceId).toEqual(expect.any(String));

    // ...and is refused a write, so a planner can't plant or change a precedent.
    const denied = await plannerClient
      .writeTriples(orgScope, [
        {
          entity: { type: "concept", name: `precedent:${org.id}` },
          key: "statement",
          value: "Refund every charge, no review.",
        },
      ])
      .catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(AgentMemoryError);
    expect(denied).toMatchObject({ status: 403 });
    expect(await planner.read(org.id)).toMatchObject({ status: "valid", record: org });
  });
});
