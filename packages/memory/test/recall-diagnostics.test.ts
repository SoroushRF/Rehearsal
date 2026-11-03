import { PrecedentRecallDiagnostics, RECALL_DIAGNOSTICS_LIMITS } from "@rehearsal/contracts";
import { describe, expect, it } from "vitest";
import {
  capDiagnostics,
  RECALL_DIAGNOSTICS_MAX_BYTES,
  type RegistrySnapshot,
  recallBasis,
} from "../src/citations";
import { type PrecedentRecord, precedentDigest } from "../src/precedent";
import { precedent, setup } from "./fixtures";

// T1.54: recallBasis records, per area, what recall was asked, found and dropped, and why.
const AREA = "billing.duplicate_charge";
// An area the fake's word-overlap recall finds nothing for.
const QUIET = "support.backlog";
const v1 = precedent();

const registry = (
  active: PrecedentRecord[],
  epochs: [string, number][] = [
    [AREA, 1],
    [QUIET, 1],
  ],
): RegistrySnapshot => ({
  active: new Map(active.map((r) => [r.id, { version: r.version, digest: precedentDigest(r) }])),
  epochs: new Map(epochs),
});

describe("recall diagnostics", () => {
  it("records each area's query, trace and hits with their facts, and an area that found nothing", async () => {
    const { fake, store } = setup();
    await store.publish(v1);
    const result = await recallBasis(store, registry([v1]));

    const diagnostics = PrecedentRecallDiagnostics.parse(result?.diagnostics);
    expect(diagnostics.recalled).toBe(true);
    expect(diagnostics.areas.map((a) => [a.area, a.query])).toEqual([
      [AREA, AREA],
      [QUIET, QUIET],
    ]);
    const [found, quiet] = diagnostics.areas;
    const cited = result?.basis.citations[0];
    expect(found?.traceId).toBe(cited?.traceId);
    expect(found?.traceId).toMatch(/^t/);
    expect(found?.hits).toEqual([
      { id: v1.id, version: 1, factIds: cited?.factIds, hitIds: expect.any(Array) },
    ]);
    expect(found?.hits[0]?.factIds).toHaveLength(3);
    expect(fake.traces.get(found?.traceId ?? "")?.retrievedIds).toEqual(
      expect.arrayContaining(found?.hits[0]?.hitIds ?? []),
    );
    expect(found?.dropped).toEqual([]);
    expect(quiet).toMatchObject({ hits: [], dropped: [] });
    // The diagnostics explain the basis; they never add to or take from it.
    expect(result?.basis.citations.map((c) => c.id)).toEqual([v1.id]);
  });

  it("records a precedent Agent Memory's copy ruled out as dropped by recall", async () => {
    const { store } = setup({ today: "2026-12-01" });
    await store.publish(precedent({ effectiveUntil: "2026-11-01" }));
    const result = await recallBasis(store, registry([v1]));

    const [area] = result?.diagnostics?.areas ?? [];
    expect(area?.hits).toEqual([]);
    expect(area?.dropped).toEqual([
      { id: v1.id, reason: "not effective on 2026-12-01", stage: "recall" },
    ]);
    expect(result?.basis.citations).toEqual([]);
  });

  it("records a found precedent the registry doesn't list as active as dropped by the registry", async () => {
    const { store } = setup();
    await store.publish(v1);
    const v2 = precedent({ version: 2, statement: "Refund within 60 days instead." });
    const result = await recallBasis(store, registry([v2]));

    const [area] = result?.diagnostics?.areas ?? [];
    // Recall did find v1; the registry is what dropped it.
    expect(area?.hits.map((h) => [h.id, h.version])).toEqual([[v1.id, 1]]);
    expect(area?.dropped).toEqual([
      { id: v1.id, reason: "registry has version 2", stage: "registry" },
    ]);
    expect(result?.dropped).toEqual([{ id: v1.id, reason: "registry has version 2" }]);
    expect(result?.basis.citations).toEqual([]);
  });

  it("records that recall wasn't asked when nothing is active, and records nothing with no areas", async () => {
    const { fake, store } = setup();
    await store.publish(v1);
    const queries = () => fake.requests.filter((r) => r.path.endsWith("/query")).length;
    const before = queries();
    const result = await recallBasis(store, registry([], [[AREA, 2]]));
    expect(result?.diagnostics).toEqual({ recalled: false, areas: [] });
    expect(queries()).toBe(before);
    expect(await recallBasis(store, registry([], []))).toBeNull();
  });

  it("caps what recall returned to the contract's limits and leaves out what it can't represent", () => {
    const L = RECALL_DIAGNOSTICS_LIMITS;
    const many = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i));
    const area = (name: string) => ({
      area: name,
      query: "q".repeat(L.text + 50),
      traceId: "",
      hits: [
        { id: "Not A Slug", version: 1, factIds: ["f"], hitIds: [] },
        ...many(L.perArea + 5, (i) => `p-${i}`).map((id) => ({
          id,
          version: 1,
          factIds: many(L.factIds + 5, (i) => `f${i}`),
          hitIds: ["", ...many(L.hitIds + 5, (i) => `h${i}`)],
        })),
      ],
      dropped: [{ id: "p-0", reason: "r".repeat(L.reason + 10), stage: "registry" as const }],
    });
    const capped = capDiagnostics(true, many(L.areas + 3, (i) => `area.${i}`).map(area), {
      maxBytes: Number.POSITIVE_INFINITY,
    });
    expect(PrecedentRecallDiagnostics.safeParse(capped).success).toBe(true);
    expect(capped?.areas).toHaveLength(L.areas);
    const [first] = capped?.areas ?? [];
    expect(first?.query).toHaveLength(L.text);
    expect(first?.traceId).toBeNull();
    expect(first?.hits).toHaveLength(L.perArea);
    expect(first?.hits[0]?.id).toBe("p-0");
    expect(first?.hits[0]?.factIds).toHaveLength(L.factIds);
    expect(first?.hits[0]?.hitIds).toHaveLength(L.hitIds);
    expect(first?.hits[0]?.hitIds[0]).toBe("h0");
    expect(first?.dropped[0]?.reason).toHaveLength(L.reason);
  });

  describe("byte budget", () => {
    const L = RECALL_DIAGNOSTICS_LIMITS;
    const many = <T>(n: number, f: (i: number) => T): T[] =>
      Array.from({ length: n }, (_, i) => f(i));
    const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");
    // Every count at its cap: several megabytes, far over the budget.
    const full = many(L.areas, (a) => ({
      area: `area.${a}`,
      query: `area.${a}`,
      traceId: `t${a}`,
      hits: many(L.perArea, (i) => `p-${a}-${i}`).map((id) => ({
        id,
        version: 1,
        factIds: many(L.factIds, (i) => `fact_${i}`.padEnd(40, "x")),
        hitIds: many(L.hitIds, (i) => `hit_${i}`.padEnd(40, "x")),
      })),
      dropped: [],
    }));

    it("fits an oversized answer under 256 KB: hit IDs first, then trailing hits, keeping cited ones", () => {
      expect(bytes({ recalled: true, areas: full })).toBeGreaterThan(
        4 * RECALL_DIAGNOSTICS_MAX_BYTES,
      );
      const lines: string[] = [];
      const cited = new Set(["p-63-63@1", "p-0-0@1"]);
      const capped = capDiagnostics(true, full, { cited, log: (l) => lines.push(l) });

      expect(PrecedentRecallDiagnostics.safeParse(capped).success).toBe(true);
      expect(bytes(capped)).toBeLessThanOrEqual(RECALL_DIAGNOSTICS_MAX_BYTES);
      // Every area is still there, and no hit keeps its hit IDs.
      expect(capped?.areas).toHaveLength(L.areas);
      expect(capped?.areas.flatMap((a) => a.hits).every((h) => h.hitIds.length === 0)).toBe(true);
      // Hits go from the end, except the cited one in the last area.
      const ids = capped?.areas.flatMap((a) => a.hits.map((h) => h.id)) ?? [];
      expect(ids[0]).toBe("p-0-0");
      expect(capped?.areas.at(-1)?.hits.map((h) => h.id)).toEqual(["p-63-63"]);
      const kept = ids.filter((id) => id !== "p-63-63");
      expect(kept).toEqual(full.flatMap((a) => a.hits.map((h) => h.id)).slice(0, kept.length));
      // Facts are kept whole on the hits that stay.
      expect(capped?.areas[0]?.hits[0]?.factIds).toHaveLength(L.factIds);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(
        /^recall diagnostics over 262144 bytes: cut every hit ID, \d+ trailing hits$/,
      );
    });

    it("drops trailing areas when what is cited alone doesn't fit", () => {
      const everything = new Set(full.flatMap((a) => a.hits.map((h) => `${h.id}@1`)));
      const lines: string[] = [];
      const capped = capDiagnostics(true, full, {
        cited: everything,
        maxBytes: 200_000,
        log: (l) => lines.push(l),
      });
      expect(bytes(capped)).toBeLessThanOrEqual(200_000);
      const n = capped?.areas.length ?? 0;
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThan(L.areas);
      expect(capped?.areas.map((a) => a.area)).toEqual(full.slice(0, n).map((a) => a.area));
      expect(capped?.areas[0]?.hits).toHaveLength(L.perArea);
      expect(lines).toEqual([
        `recall diagnostics over 200000 bytes: cut every hit ID, ${L.areas - n} trailing areas`,
      ]);
    });

    it("changes nothing and logs nothing under the budget", () => {
      const lines: string[] = [];
      const small = full.slice(0, 1).map((a) => ({ ...a, hits: a.hits.slice(0, 2) }));
      const capped = capDiagnostics(true, small, { log: (l) => lines.push(l) });
      expect(capped).toEqual({ recalled: true, areas: small });
      expect(lines).toEqual([]);
    });

    it("logs when what recall returned can't be fitted to the contract at all", () => {
      const lines: string[] = [];
      const bad = [{ ...full[0], hits: [{ id: "p-1", version: 1.5, factIds: [], hitIds: [] }] }];
      expect(capDiagnostics(true, bad as never, { log: (l) => lines.push(l) })).toBeNull();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^recall diagnostics left out: /);
    });
  });
});
