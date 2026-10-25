import { describe, expect, it } from "vitest";
import {
  checkPrecedentBasis,
  citePrecedents,
  PrecedentBasis,
  type PrecedentCitation,
  type RegistrySnapshot,
} from "../src/citations";
import { memoryConfigFromEnv, precedentsFromEnv } from "../src/config";
import { precedentDigest } from "../src/precedent";
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
