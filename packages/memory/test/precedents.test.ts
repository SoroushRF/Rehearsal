import { canonicalize } from "@rehearsal/core";
import { describe, expect, it } from "vitest";
import { AgentMemoryClient, AgentMemoryError } from "../src/client";
import { precedentDigest, toTriples } from "../src/precedent";
import {
  AgentMemoryPrecedents,
  PrecedentConflictError,
  PrecedentReadbackError,
} from "../src/precedents";
import { precedent, SCOPE, setup } from "./fixtures";

const NAME = "precedent:duplicate-charge-refund";

describe("publish", () => {
  it("registers the scope, writes the precedent and returns what readback validated", async () => {
    const { fake, store } = setup();
    const published = await store.publish(precedent());
    expect(published).toEqual({
      id: "duplicate-charge-refund",
      version: 1,
      digest: precedentDigest(precedent()),
      factIds: expect.any(Array),
      scope: SCOPE,
      written: true,
    });
    expect(published.factIds).toHaveLength(3);
    expect(fake.scopes.has(SCOPE)).toBe(true);
    expect(await store.read("duplicate-charge-refund")).toMatchObject({
      status: "valid",
      record: precedent(),
    });
  });

  it("writes nothing when the same version is published again, so the outbox can retry", async () => {
    const { fake, store } = setup();
    const first = await store.publish(precedent());
    const again = await store.publish(precedent());
    expect(again).toEqual({ ...first, written: false });
    expect(fake.writes).toBe(1);
  });

  it("replaces the version and keeps the old one in history", async () => {
    const { store } = setup();
    await store.publish(precedent());
    const v2 = precedent({ version: 2, statement: "Refund within 60 days instead." });
    await store.publish(v2);

    expect(await store.read("duplicate-charge-refund")).toMatchObject({ record: v2 });
    const history = await store.history("duplicate-charge-refund");
    expect(history.map((h) => [h.record?.version, h.superseded])).toEqual([
      [2, false],
      [1, true],
    ]);
  });

  it("refuses an older version, even after a newer one", async () => {
    const { fake, store } = setup();
    await store.publish(precedent({ version: 2 }));
    await expect(store.publish(precedent({ version: 1 }))).rejects.toThrow(PrecedentConflictError);
    await store.publish(precedent({ version: 3 }));
    await expect(store.publish(precedent({ version: 2 }))).rejects.toThrow(/v3 is already stored/);
    expect(fake.writes).toBe(2);
  });

  it("refuses the same version with different content", async () => {
    const { store } = setup();
    await store.publish(precedent());
    await expect(store.publish(precedent({ exceptions: [] }))).rejects.toThrow(
      /v1 is already stored with different content/,
    );
  });

  it("repairs a partly written copy by writing the version again", async () => {
    const { fake, store } = setup();
    fake.scopes.add(SCOPE);
    fake.seed(SCOPE, NAME, "statement", precedent().statement);
    expect(await store.read("duplicate-charge-refund")).toEqual({
      status: "invalid",
      reason: 'missing attribute "version"',
    });
    expect((await store.publish(precedent())).written).toBe(true);
    expect((await store.read("duplicate-charge-refund")).status).toBe("valid");
  });

  it("fails when the stored copy doesn't read back as published", async () => {
    const { fake, client } = setup();
    const store = new AgentMemoryPrecedents(client, { scope: SCOPE });
    const write = client.writeTriples.bind(client);
    client.writeTriples = async (scope, triples) => {
      const result = await write(scope, triples);
      fake.tamper(NAME, "statement", "Refund everything.");
      return result;
    };
    await expect(store.publish(precedent())).rejects.toThrow(PrecedentReadbackError);
    await expect(store.publish(precedent({ version: 2 }))).rejects.toThrow(
      /statement disagrees with record/,
    );
  });

  it("fails when another version is stored by the time it reads back", async () => {
    const { client } = setup();
    const store = new AgentMemoryPrecedents(client, { scope: SCOPE });
    const write = client.writeTriples.bind(client);
    client.writeTriples = async (scope) => write(scope, toTriples(precedent({ version: 9 })));
    await expect(store.publish(precedent())).rejects.toThrow(/stored v9 is not the version/);
  });

  it("is refused outside the key's write region", async () => {
    const { fake, store } = setup({ key: "sp-narrow" });
    fake.keys.set("sp-narrow", { read: [""], write: ["rehearsal/elsewhere"] });
    const error = await store.publish(precedent()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentMemoryError);
    expect(error).toMatchObject({ status: 403 });
    expect(fake.attrs).toHaveLength(0);
  });

  it("validates the record before touching the service", async () => {
    const { fake, store } = setup();
    await expect(store.publish(precedent({ version: 0 }))).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
  });
});

describe("read", () => {
  it("is absent when nothing is stored, or only in other scopes", async () => {
    const { fake, store } = setup();
    expect(await store.read("duplicate-charge-refund")).toEqual({ status: "absent" });
    fake.seed(`${SCOPE}/other`, NAME, "statement", "Refund everything.");
    expect(await store.read("duplicate-charge-refund")).toEqual({ status: "absent" });
  });

  it("ignores a value forged in a neighbouring scope on the same entity", async () => {
    const { fake, store } = setup();
    await store.publish(precedent());
    fake.seed(`${SCOPE}/other`, NAME, "statement", "Refund everything.");
    fake.seed("rehearsal", NAME, "record", "{}");
    expect(await store.read("duplicate-charge-refund")).toMatchObject({
      status: "valid",
      record: precedent(),
    });
  });

  it("propagates an outage instead of reporting the precedent absent", async () => {
    const { fake, store } = setup();
    fake.outage = 503;
    await expect(store.read("duplicate-charge-refund")).rejects.toMatchObject({ status: 503 });
  });
});

describe("history", () => {
  it("lists only our scope's records, newest first, flagging ones that don't parse", async () => {
    const { fake, store } = setup();
    await store.publish(precedent());
    fake.seed(`${SCOPE}/other`, NAME, "record", canonicalize(precedent({ version: 7 })));
    await store.publish(precedent({ version: 2 }));
    fake.tamper(NAME, "record", "not json", SCOPE);

    const history = await store.history("duplicate-charge-refund");
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ record: null, reason: "not JSON", superseded: false });
    expect(history[1]).toMatchObject({ record: precedent(), superseded: true });
    expect((history[0]?.recordedAt ?? "") > (history[1]?.recordedAt ?? "")).toBe(true);
  });

  it("is empty for a precedent never stored", async () => {
    expect(await setup().store.history("never")).toEqual([]);
  });
});

describe("recall", () => {
  it("returns each matching precedent once, read back in full, with hit IDs and trace", async () => {
    const { fake, store } = setup();
    await store.publish(precedent());
    await store.publish(
      precedent({
        id: "partial-refund",
        appliesTo: "billing.partial",
        statement: "Partial charge refunds need finance.",
      }),
    );

    const recall = await store.recall("duplicate charge refund");
    expect(recall.precedents.map((p) => p.id)).toEqual([
      "duplicate-charge-refund",
      "partial-refund",
    ]);
    const [first] = recall.precedents;
    expect(first).toMatchObject({
      id: "duplicate-charge-refund",
      version: 1,
      statement: precedent().statement,
      author: { userId: "user_finance_1", role: "finance_lead" },
      record: precedent(),
      digest: precedentDigest(precedent()),
    });
    expect(first?.factIds).toHaveLength(3);
    expect(first?.hitIds.length).toBeGreaterThan(0);
    expect(recall.traceId).toMatch(/^t/);
    expect(fake.traces.get(recall.traceId ?? "")?.retrievedIds).toEqual(
      expect.arrayContaining(first?.hitIds ?? []),
    );
    expect(recall.rejected).toEqual([]);
  });

  it("recalls through the store's scope only", async () => {
    const { fake, store } = setup();
    fake.scopes.add("rehearsal/other");
    fake.seed("rehearsal/other", NAME, "statement", "duplicate charge refund elsewhere");
    const recall = await store.recall("duplicate charge refund");
    expect(recall.precedents).toEqual([]);
    expect(recall.rejected).toEqual([]);
    expect(fake.requests.at(-1)?.body).toMatchObject({ lens: [[SCOPE]], include: ["facts"] });
  });

  it("returns the version readback finds, not what the hit text says", async () => {
    const { fake, store } = setup();
    await store.publish(precedent());
    fake.seed(SCOPE, "unrelated", "note", "duplicate charge refund v99");
    const recall = await store.recall("duplicate charge refund");
    expect(recall.precedents.map((p) => [p.id, p.version])).toEqual([
      ["duplicate-charge-refund", 1],
    ]);
  });

  it("rejects precedents that aren't effective today or don't read back", async () => {
    const { fake, store } = setup({ today: "2026-12-01" });
    await store.publish(precedent({ effectiveUntil: "2026-11-01" }));
    await store.publish(precedent({ id: "broken-charge", statement: "Broken duplicate charge." }));
    fake.tamper("precedent:broken-charge", "statement", "duplicate charge, but tampered");

    const recall = await store.recall("duplicate charge");
    expect(recall.precedents).toEqual([]);
    expect(recall.rejected).toEqual(
      expect.arrayContaining([
        { id: "duplicate-charge-refund", reason: "not effective on 2026-12-01" },
        { id: "broken-charge", reason: "statement disagrees with record" },
      ]),
    );
  });

  it("finds nothing through a key that can't read the scope", async () => {
    const { fake, store } = setup();
    await store.publish(precedent());
    fake.keys.set("sp-narrow", { read: ["rehearsal/elsewhere"], write: [] });
    const narrow = new AgentMemoryPrecedents(
      new AgentMemoryClient({
        url: "http://fake",
        context: "ctx",
        apiKey: "sp-narrow",
        fetch: fake.fetch,
      }),
      { scope: SCOPE },
    );
    expect((await narrow.recall("duplicate charge refund")).precedents).toEqual([]);
    expect(await narrow.read("duplicate-charge-refund")).toEqual({ status: "absent" });
    expect((await store.recall("duplicate charge refund")).precedents).toHaveLength(1);
  });

  it("fails on an outage, so a plan that needs precedents is blocked, not planned without them", async () => {
    const { fake, store } = setup();
    fake.outage = 503;
    await expect(store.recall("duplicate charge")).rejects.toBeInstanceOf(AgentMemoryError);
  });
});

describe("options", () => {
  const { client } = setup();
  it("needs a valid scope and k", () => {
    expect(() => new AgentMemoryPrecedents(client, { scope: "Rehearsal/X" })).toThrow(/scope/);
    expect(() => new AgentMemoryPrecedents(client, { scope: "" })).toThrow(/scope/);
    expect(() => new AgentMemoryPrecedents(client, { scope: SCOPE, k: 51 })).toThrow(/k must/);
    expect(() => new AgentMemoryPrecedents(client, { scope: SCOPE, k: 0 })).toThrow(/k must/);
    expect(new AgentMemoryPrecedents(client, { scope: `${SCOPE}/` }).scope).toBe(SCOPE);
  });
});
