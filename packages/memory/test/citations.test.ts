import { describe, expect, it } from "vitest";
import {
  checkPrecedentBasis,
  citePrecedents,
  PrecedentBasis,
  type PrecedentCitation,
  type RegistrySnapshot,
  recallBasis,
} from "../src/citations";
import { memoryConfigFromEnv, precedentsFromEnv } from "../src/config";
import { type PrecedentRecord, precedentDigest } from "../src/precedent";
import type { PrecedentRecall } from "../src/precedents";
import { precedent, setup } from "./fixtures";

const AREA = "billing.duplicate_charge";
const v1 = precedent();
const v2 = precedent({ version: 2, statement: "Refund within 60 days instead." });

const cite = (record = v1): PrecedentCitation => ({
  id: record.id,
  version: record.version,
  digest: precedentDigest(record),
  appliesTo: record.appliesTo,
  factIds: ["a1", "a2", "a3"],
  traceId: "t1",
});

const registry = (
  active: [string, typeof v1][],
  epochs: [string, number][] = [[AREA, 1]],
): RegistrySnapshot => ({
  active: new Map(
    active.map(([id, r]) => [id, { version: r.version, digest: precedentDigest(r) }]),
  ),
  epochs: new Map(epochs),
});

describe("checkPrecedentBasis", () => {
  const basis = { citations: [cite()], epochs: { [AREA]: 1 } };

  it("passes when every cited version is still the active one and no area moved", () => {
    expect(checkPrecedentBasis(basis, registry([[v1.id, v1]]))).toEqual({ ok: true });
  });

  it("holds the plan when the cited precedent was changed and re-approved", () => {
    expect(checkPrecedentBasis(basis, registry([[v1.id, v2]], [[AREA, 2]]))).toEqual({
      ok: false,
      holds: [
        { id: v1.id, reason: "superseded", citedVersion: 1, activeVersion: 2 },
        { appliesTo: AREA, reason: "epoch_changed", plannedEpoch: 1, currentEpoch: 2 },
      ],
    });
  });

  it("holds on a superseded version even if the epoch was somehow left alone", () => {
    const result = checkPrecedentBasis(basis, registry([[v1.id, v2]]));
    expect(result).toEqual({
      ok: false,
      holds: [{ id: v1.id, reason: "superseded", citedVersion: 1, activeVersion: 2 }],
    });
  });

  it("holds when the cited precedent was withdrawn", () => {
    expect(checkPrecedentBasis(basis, registry([]))).toMatchObject({
      ok: false,
      holds: [{ id: v1.id, reason: "withdrawn", activeVersion: null }],
    });
  });

  it("holds when the plan cites a version that isn't active yet", () => {
    const ahead = { citations: [cite(v2)], epochs: { [AREA]: 1 } };
    expect(checkPrecedentBasis(ahead, registry([[v1.id, v1]]))).toMatchObject({
      ok: false,
      holds: [{ reason: "not_active", citedVersion: 2, activeVersion: 1 }],
    });
  });

  it("holds when the active version's content differs from what was cited", () => {
    const edited = precedent({ exceptions: [] });
    expect(checkPrecedentBasis(basis, registry([[v1.id, edited]]))).toMatchObject({
      ok: false,
      holds: [{ reason: "content_changed", citedVersion: 1, activeVersion: 1 }],
    });
  });

  it("holds when a precedent recall never returned appears in a consulted area", () => {
    const none = { citations: [], epochs: { [AREA]: 0 } };
    expect(checkPrecedentBasis(none, registry([], []))).toEqual({ ok: true });
    expect(checkPrecedentBasis(none, registry([], [[AREA, 1]]))).toEqual({
      ok: false,
      holds: [{ appliesTo: AREA, reason: "epoch_changed", plannedEpoch: 0, currentEpoch: 1 }],
    });
  });

  it("ignores areas the plan didn't consult", () => {
    const other = registry(
      [[v1.id, v1]],
      [
        [AREA, 1],
        ["billing.partial", 9],
      ],
    );
    expect(checkPrecedentBasis(basis, other)).toEqual({ ok: true });
  });

  it("refuses a basis that cites an area without its epoch, or is malformed", () => {
    expect(PrecedentBasis.safeParse({ citations: [cite()], epochs: {} }).success).toBe(false);
    expect(() => checkPrecedentBasis({ citations: [cite()], epochs: {} }, registry([]))).toThrow();
    const bad = { ...cite(), digest: "nope" };
    expect(PrecedentBasis.safeParse({ citations: [bad], epochs: { [AREA]: 1 } }).success).toBe(
      false,
    );
  });
});

describe("citePrecedents", () => {
  it("records each recalled version with its digest, facts and the recall's trace", async () => {
    const { store } = setup();
    const published = await store.publish(v1);
    const recall = await store.recall("duplicate charge refund");
    const citations = citePrecedents(recall);
    expect(citations).toEqual([
      {
        id: v1.id,
        version: 1,
        digest: published.digest,
        appliesTo: AREA,
        factIds: published.factIds,
        traceId: recall.traceId,
      },
    ]);
    const basis = PrecedentBasis.parse({ citations, epochs: { [AREA]: 1 } });
    expect(checkPrecedentBasis(basis, registry([[v1.id, v1]]))).toEqual({ ok: true });
  });
});

describe("config from env", () => {
  const env = {
    SURREAL_AGENT_MEMORY_URL: "https://mem.test",
    SURREAL_AGENT_MEMORY_CONTEXT: "ctx",
    SURREAL_AGENT_MEMORY_KEY: "sp-key",
  };

  it("is core mode (null) when nothing is set", () => {
    expect(memoryConfigFromEnv({})).toBeNull();
    expect(memoryConfigFromEnv({ SURREAL_AGENT_MEMORY_URL: "" })).toBeNull();
    expect(precedentsFromEnv({})).toBeNull();
  });

  it("throws when only some variables are set, naming the missing ones", () => {
    expect(() => memoryConfigFromEnv({ SURREAL_AGENT_MEMORY_URL: "https://mem.test" })).toThrow(
      /SURREAL_AGENT_MEMORY_CONTEXT, SURREAL_AGENT_MEMORY_KEY/,
    );
  });

  it("defaults the scope and takes an override", () => {
    expect(memoryConfigFromEnv(env)).toEqual({
      url: "https://mem.test",
      context: "ctx",
      apiKey: "sp-key",
      scope: "rehearsal/precedents",
    });
    const store = precedentsFromEnv({ ...env, SURREAL_AGENT_MEMORY_SCOPE: "rehearsal/demo" });
    expect(store?.scope).toBe("rehearsal/demo");
  });
});

describe("recallBasis", () => {
  const OTHER = "billing.refund_window";
  const other = precedent({ id: "refund-window", appliesTo: OTHER });
  const recalled = (record: PrecedentRecord, traceId = "t1") => ({
    precedents: [
      {
        id: record.id,
        version: record.version,
        statement: record.statement,
        author: record.author,
        record,
        digest: precedentDigest(record),
        factIds: ["a1", "a2", "a3"],
        hitIds: ["h1"],
      },
    ],
    traceId,
    rejected: [],
  });
  const recaller = (byArea: Record<string, PrecedentRecall>) => {
    const asked: string[] = [];
    return {
      asked,
      recall: async (area: string) => {
        asked.push(area);
        return byArea[area] ?? { precedents: [], traceId: null, rejected: [] };
      },
    };
  };

  it("cites the active version with its facts and trace, and records every area's epoch", async () => {
    const r = recaller({ [AREA]: recalled(v1) });
    const result = await recallBasis(
      r,
      registry(
        [[v1.id, v1]],
        [
          [AREA, 1],
          [OTHER, 2],
        ],
      ),
    );
    expect(r.asked).toEqual([AREA, OTHER]);
    expect(result?.basis).toEqual({ citations: [cite()], epochs: { [AREA]: 1, [OTHER]: 2 } });
    expect(result?.precedents.map((p) => p.id)).toEqual([v1.id]);
    expect(result?.dropped).toEqual([]);
  });

  it("drops what memory still holds but the registry doesn't list as active", async () => {
    // Memory keeps a withdrawn precedent's copy and an old version's: neither may be cited.
    const r = recaller({ [AREA]: recalled(v1), [OTHER]: recalled(other) });
    const result = await recallBasis(
      r,
      registry(
        [[v1.id, v2]],
        [
          [AREA, 2],
          [OTHER, 2],
        ],
      ),
    );
    expect(result?.basis.citations).toEqual([]);
    expect(result?.dropped).toEqual([
      { id: v1.id, reason: "registry has version 2" },
      { id: other.id, reason: "not active in the registry" },
    ]);
  });

  it("drops a recalled copy whose content differs from the approved version", async () => {
    const tampered = { ...v1, statement: "Refund everything." };
    const result = await recallBasis(
      recaller({ [AREA]: recalled(tampered) }),
      registry([[v1.id, v1]]),
    );
    expect(result?.dropped).toEqual([
      { id: v1.id, reason: "content differs from the approved version" },
    ]);
  });

  it("binds the epochs without recalling when nothing is active, and is null with no areas", async () => {
    const r = recaller({});
    expect((await recallBasis(r, registry([], [[AREA, 2]])))?.basis).toEqual({
      citations: [],
      epochs: { [AREA]: 2 },
    });
    expect(r.asked).toEqual([]);
    expect(await recallBasis(r, registry([], []))).toBeNull();
  });

  it("lets a recall failure through, so a plan isn't made without its precedents", async () => {
    const down = { recall: async () => Promise.reject(new Error("memory down")) };
    await expect(recallBasis(down, registry([[v1.id, v1]]))).rejects.toThrow("memory down");
  });
});
