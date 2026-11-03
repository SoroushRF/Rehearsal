import { PrecedentRecallDiagnostics, RECALL_DIAGNOSTICS_LIMITS } from "@rehearsal/contracts";
import { describe, expect, it } from "vitest";
import { capDiagnostics, type RegistrySnapshot, recallBasis } from "../src/citations";
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
    const capped = capDiagnostics(true, many(L.areas + 3, (i) => `area.${i}`).map(area));
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
});
