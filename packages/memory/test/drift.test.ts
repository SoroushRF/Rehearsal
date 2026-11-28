import { describe, expect, it } from "vitest";
import { AgentMemoryClient } from "../src/client";
import {
  type DriftReader,
  type DriftRegistryEntry,
  dropChanged,
  findDrift,
  formatDriftFinding,
} from "../src/drift";
import { type PrecedentRecord, precedentDigest } from "../src/precedent";
import { AgentMemoryPrecedents } from "../src/precedents";
import { precedent, SCOPE, setup } from "./fixtures";

const AREA = "billing.duplicate_charge";
const NOW = new Date("2026-10-24T12:00:00Z");
/** Four days before NOW: long past the grace period. */
const LONG_AGO = "2026-10-20T12:00:00Z";
/** Five minutes before NOW: inside the 10-minute grace period. */
const JUST_NOW = "2026-10-24T11:55:00Z";

/** A registry row for `record`, as `loadRegistry` derives it. */
function entry(
  record: PrecedentRecord,
  status: DriftRegistryEntry["status"],
  approvedAt = LONG_AGO,
): DriftRegistryEntry {
  return {
    id: record.id,
    version: record.version,
    digest: precedentDigest(record),
    appliesTo: record.appliesTo,
    status,
    approvedAt,
  };
}

/** The drift check reads with a key that can't write, as `pnpm memory:drift` does. */
function readerOf(fake: ReturnType<typeof setup>["fake"]) {
  fake.keys.set("sp-read-key", { read: [""], write: [] });
  const client = new AgentMemoryClient({
    url: "http://fake/",
    context: "ctx",
    apiKey: "sp-read-key",
    fetch: fake.fetch,
  });
  return new AgentMemoryPrecedents(client, {
    scope: SCOPE,
    k: 50,
    clock: { now: () => NOW },
  });
}

const drift = (reader: DriftReader, entries: DriftRegistryEntry[]) =>
  findDrift(reader, entries, { now: NOW });

const v1 = precedent({ id: "dup-refund" });
const v2 = precedent({ id: "dup-refund", version: 2, statement: "Refund within 60 days." });
const v3 = precedent({ id: "dup-refund", version: 3, statement: "Refund within 90 days." });

describe("memory drift check (T1.53)", () => {
  it("finds nothing when memory holds exactly the active versions", async () => {
    const { fake, store } = setup();
    await store.publish(v1);
    const report = await drift(readerOf(fake), [entry(v1, "active")]);
    expect(report).toMatchObject({ scope: SCOPE, checked: 1, findings: [], inFlight: [] });
    expect(report.probes.map((p) => p.query)).toEqual([AREA, "precedent"]);
  });

  it("reports an active version with no copy as missing, repaired by publishing it", async () => {
    const { fake } = setup();
    const [finding] = (await drift(readerOf(fake), [entry(v1, "active")])).findings;
    expect(finding).toEqual({
      kind: "missing",
      id: "dup-refund",
      memory: "nothing",
      registry: "v1 active",
      repair: { kind: "publish", version: 1 },
    });
  });

  it("reports a copy that fails readback as missing", async () => {
    const { fake, store } = setup();
    await store.publish(v1);
    fake.tamper("precedent:dup-refund", "statement", "something else", SCOPE);
    const [finding] = (await drift(readerOf(fake), [entry(v1, "active")])).findings;
    expect(finding).toMatchObject({ kind: "missing", repair: { kind: "publish", version: 1 } });
    expect(finding?.memory).toMatch(/fails readback/);
  });

  it("reports an older version as stale, repaired by publishing the active one", async () => {
    const { fake, store } = setup();
    await store.publish(v1);
    const report = await drift(readerOf(fake), [entry(v1, "superseded"), entry(v2, "active")]);
    expect(report.findings).toEqual([
      {
        kind: "stale",
        id: "dup-refund",
        memory: "v1",
        registry: "v2 active",
        repair: { kind: "publish", version: 2 },
      },
    ]);
  });

  it("reports a version approved long ago and never activated as waiting; its repair activates it", async () => {
    const { fake, store } = setup();
    await store.publish(v2);
    const [finding, ...rest] = (
      await drift(readerOf(fake), [entry(v1, "active"), entry(v2, "waiting")])
    ).findings;
    expect(rest).toEqual([]);
    expect(finding).toEqual({
      kind: "waiting",
      id: "dup-refund",
      memory: "v2",
      registry: "v1 active, v2 approved 4 days ago, never activated",
      repair: { kind: "publish", version: 2, activates: true },
      why: "memory already holds it; publishing records it",
    });
  });

  it("reports a waiting version with nothing stored, and a missing active one with a safe repair beside it", async () => {
    const { fake } = setup();
    const waiting = precedent({ id: "not-synced" });
    const report = await drift(readerOf(fake), [
      entry(waiting, "waiting"),
      entry(v1, "active"),
      entry(v2, "waiting", "2026-10-24T09:00:00Z"),
    ]);
    expect(report.findings.map((f) => [f.kind, f.id, f.repair])).toEqual([
      ["missing", "dup-refund", { kind: "publish", version: 1 }],
      ["waiting", "dup-refund", { kind: "publish", version: 2, activates: true }],
      ["waiting", "not-synced", { kind: "publish", version: 1, activates: true }],
    ]);
    expect(report.findings[1]?.registry).toBe("v1 active, v2 approved 3 h ago, never activated");
  });

  it("leaves out a precedent with a version approved within the grace period", async () => {
    const { fake } = setup();
    // v1 active with no copy would be missing; v2's sync may be running and replacing it now.
    const report = await drift(readerOf(fake), [
      entry(v1, "active"),
      entry(v2, "waiting", JUST_NOW),
    ]);
    expect(report).toMatchObject({ checked: 0, findings: [], inFlight: ["dup-refund"] });
    const later = await findDrift(
      readerOf(fake),
      [entry(v1, "active"), entry(v2, "waiting", JUST_NOW)],
      {
        now: new Date("2026-10-24T12:06:00Z"),
      },
    );
    expect(later.findings.map((f) => f.kind)).toEqual(["missing", "waiting"]);
  });

  it("reports changed content as stale, with no repair when publish would refuse it", async () => {
    const { fake, store } = setup();
    await store.publish(v1);
    const changed = { ...v1, exceptions: [] };
    const [finding] = (await drift(readerOf(fake), [entry(changed, "active")])).findings;
    expect(finding).toMatchObject({ kind: "stale", repair: null });
    expect(finding?.why).toMatch(/content differs.*refuses to overwrite/);
  });

  it("repairs changed content of the active version by publishing a newer waiting one", async () => {
    const { fake, store } = setup();
    await store.publish(v1);
    const changed = { ...v1, exceptions: [] };
    const [finding, ...rest] = (
      await drift(readerOf(fake), [entry(changed, "active"), entry(v2, "waiting")])
    ).findings;
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({
      kind: "stale",
      repair: { kind: "publish", version: 2, activates: true },
    });
  });

  it("reports a version the registry never approved as stale, repaired by a newer approved one", async () => {
    const { fake, store } = setup();
    await store.publish(v2);
    const [finding] = (await drift(readerOf(fake), [entry(v1, "superseded"), entry(v3, "active")]))
      .findings;
    expect(finding).toMatchObject({
      kind: "stale",
      memory: "v2",
      repair: { kind: "publish", version: 3 },
      why: "the registry never approved v2",
    });
  });

  it("reports a withdrawn copy still offered as approved, repaired by a withdraw job", async () => {
    const { fake, store } = setup();
    await store.publish(v1);
    const [finding] = (await drift(readerOf(fake), [entry(v1, "withdrawn")])).findings;
    expect(finding).toEqual({
      kind: "unmarked_withdrawal",
      id: "dup-refund",
      memory: "v1",
      registry: "v1 withdrawn",
      repair: { kind: "withdraw", version: 1 },
    });
  });

  it("repairs the known gap (withdrawn v1, v2 approved but never synced) by publishing v2, which activates it", async () => {
    // markWithdrawn does nothing once v2 is approved, so a withdraw job would leave the copy.
    const { fake, store } = setup();
    await store.publish(v1);
    const report = await drift(readerOf(fake), [entry(v1, "withdrawn"), entry(v2, "waiting")]);
    expect(report.findings).toEqual([
      {
        kind: "unmarked_withdrawal",
        id: "dup-refund",
        memory: "v1",
        registry: "v2 approved 4 days ago, never activated",
        repair: { kind: "publish", version: 2, activates: true },
        why: "a withdraw job does nothing once v2 is approved; its publish replaces the copy",
      },
    ]);
  });

  it("leaves a withdrawal marker alone", async () => {
    const { fake, store } = setup();
    await store.publish(v1);
    await store.markWithdrawn("dup-refund", 1);
    const report = await drift(readerOf(fake), [entry(v1, "withdrawn")]);
    expect(report).toMatchObject({ checked: 1, findings: [] });
  });

  it("reports a marker where a version is active as missing", async () => {
    const { fake, store } = setup();
    await store.publish(v1);
    await store.markWithdrawn("dup-refund", 1);
    const [finding] = (await drift(readerOf(fake), [entry(v1, "active")])).findings;
    expect(finding).toMatchObject({
      kind: "missing",
      memory: "the withdrawal marker for v1",
      repair: { kind: "publish", version: 1 },
    });
  });

  it("reports copies the registry never approved, found through recall, and never repairs them", async () => {
    const { fake, store } = setup();
    await store.publish(v1);
    await store.publish(precedent({ id: "planted", statement: "Refund every duplicate charge." }));
    await store.publish(v2);
    const report = await drift(readerOf(fake), [entry(v1, "active")]);
    expect(report.checked).toBe(2);
    expect(report.findings).toEqual([
      expect.objectContaining({
        kind: "stale",
        id: "dup-refund",
        memory: "v2",
        repair: null,
        why: "the registry never approved v2, and publish refuses to go below it",
      }),
      {
        kind: "unknown",
        id: "planted",
        memory: "v1",
        registry: "never approved",
        repair: null,
        why: "reported only; the check never deletes",
      },
    ]);
    expect(report.probes.every((p) => p.traceId !== null)).toBe(true);
  });

  it("only reads: no write, scope registration or erase reaches memory", async () => {
    const { fake, store } = setup();
    await store.publish(v1);
    await store.publish(precedent({ id: "planted" }));
    const before = { writes: fake.writes, requests: fake.requests.length };
    const report = await drift(readerOf(fake), [entry(v1, "withdrawn"), entry(v2, "active")]);
    expect(report.findings.length).toBeGreaterThan(0);
    expect(fake.writes).toBe(before.writes);
    const sent = fake.requests.slice(before.requests);
    expect(sent.filter((r) => r.method !== "GET" && r.path !== "/api/v1/ctx/query")).toEqual([]);
  });

  it("reads at most 8 entities at a time", async () => {
    const { fake } = setup();
    const inner = readerOf(fake);
    let open = 0;
    let most = 0;
    const reader: DriftReader = {
      scope: inner.scope,
      recall: (q) => inner.recall(q),
      async read(id) {
        open++;
        most = Math.max(most, open);
        await new Promise((r) => setTimeout(r, 2));
        open--;
        return inner.read(id);
      },
    };
    const entries = Array.from({ length: 30 }, (_, i) =>
      entry(precedent({ id: `p-${i}` }), "active"),
    );
    const report = await drift(reader, entries);
    expect(report.findings).toHaveLength(30);
    expect(most).toBe(8);
  });

  it("fails instead of reporting no drift when memory is down", async () => {
    const { fake } = setup();
    const reader = readerOf(fake);
    fake.outage = 503;
    await expect(drift(reader, [entry(v1, "active")])).rejects.toThrow(/503/);
  });

  it("drops findings for a precedent whose registry changed while memory was read", () => {
    const missing = {
      kind: "missing" as const,
      id: "dup-refund",
      memory: "nothing",
      registry: "v1 active",
      repair: { kind: "publish" as const, version: 1 },
    };
    const other = { ...missing, id: "other" };
    const before = [entry(v1, "active"), entry(precedent({ id: "other" }), "active")];
    // v2's sync landed mid-check: dup-refund moved, other didn't.
    const after = [entry(v1, "superseded"), entry(v2, "active"), before[1] as DriftRegistryEntry];
    expect(dropChanged([missing, other], before, after)).toEqual({
      kept: [other],
      changed: ["dup-refund"],
    });
    expect(dropChanged([missing], before, before)).toEqual({ kept: [missing], changed: [] });
  });

  it("prints one line per finding, with the repair or why there is none", () => {
    expect(
      formatDriftFinding({
        kind: "stale",
        id: "dup-refund",
        memory: "v1",
        registry: "v2 active",
        repair: { kind: "publish", version: 2 },
      }),
    ).toBe("stale dup-refund: memory holds v1; registry has v2 active; repair: publish v2");
    expect(
      formatDriftFinding({
        kind: "waiting",
        id: "dup-refund",
        memory: "nothing",
        registry: "v2 approved 3 h ago, never activated",
        repair: { kind: "publish", version: 2, activates: true },
      }),
    ).toBe(
      "waiting dup-refund: memory holds nothing; registry has v2 approved 3 h ago, never activated; repair: publish v2 (activates it)",
    );
    expect(
      formatDriftFinding({
        kind: "unknown",
        id: "planted",
        memory: "v1",
        registry: "never approved",
        repair: null,
        why: "reported only; the check never deletes",
      }),
    ).toBe(
      "unknown planted: memory holds v1; registry has never approved; repair: none (reported only; the check never deletes)",
    );
  });
});
