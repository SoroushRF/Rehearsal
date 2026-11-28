import { randomUUID } from "node:crypto";
import type { PrecedentBasis, PrecedentRecallDiagnostics } from "@rehearsal/contracts";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  loadRecallDiagnostics,
  migrateDb,
  recordRecallDiagnostics,
  schema,
} from "../src";

const AREA = "billing.duplicate_charge";
const basis: PrecedentBasis = {
  citations: [
    {
      id: "dup-refund",
      version: 2,
      digest: "d".repeat(64),
      appliesTo: AREA,
      factIds: ["f1", "f2"],
      traceId: "trace_1",
    },
  ],
  epochs: { [AREA]: 3 },
};
const diagnostics: PrecedentRecallDiagnostics = {
  recalled: true,
  areas: [
    {
      area: AREA,
      query: AREA,
      traceId: "trace_1",
      hits: [{ id: "dup-refund", version: 2, factIds: ["f1", "f2"], hitIds: ["h1"] }],
      dropped: [{ id: "old-rule", reason: "registry has version 3", stage: "registry" }],
    },
  ],
};

// Needs a real Postgres: `pnpm infra:up` then `DB_TESTS=1 pnpm --filter @rehearsal/db test`.
describe.skipIf(!process.env.DB_TESTS)("plan recall diagnostics (T1.54, real Postgres)", () => {
  const url = process.env.DATABASE_URL ?? "postgres://rehearsal:rehearsal@localhost:5432/rehearsal";
  const db = createDb(url);
  beforeAll(() => migrateDb(db));
  afterAll(() => db.$client.end());

  const key = () => ({ orgId: `org_${randomUUID()}`, planId: `plan_${randomUUID()}` });
  const record = (k: { orgId: string; planId: string }, revision: number, d = diagnostics) =>
    recordRecallDiagnostics(db, {
      ...k,
      revision,
      planHash: "a".repeat(64),
      basis,
      diagnostics: d,
    });

  it("stores them once per revision and reads them back for the basis they explain", async () => {
    const k = key();
    expect(await record(k, 1)).toBe(true);
    // Append-only: a second account for the same revision doesn't replace the first.
    expect(await record(k, 1, { recalled: false, areas: [] })).toBe(false);
    const loaded = await loadRecallDiagnostics(db, { ...k, revision: 1, basis });
    expect(loaded).toMatchObject({ revision: 1, diagnostics });
    expect(loaded?.recordedAt).toMatch(/^\d{4}-/);
    // Another org's plan with the same ID sees nothing.
    expect(
      await loadRecallDiagnostics(db, { ...k, orgId: `org_${randomUUID()}`, revision: 1, basis }),
    ).toBeNull();
  });

  it("serves a reviewer's later revision its parent's diagnostics only while the basis is the same", async () => {
    const k = key();
    await record(k, 1);
    expect(await loadRecallDiagnostics(db, { ...k, revision: 2, basis })).toMatchObject({
      revision: 1,
    });
    // Same citations, but the keys in another order: still the same basis.
    const reordered = { epochs: basis.epochs, citations: basis.citations };
    expect(await loadRecallDiagnostics(db, { ...k, revision: 2, basis: reordered })).not.toBeNull();
    const moved = { ...basis, epochs: { [AREA]: 4 } };
    expect(await loadRecallDiagnostics(db, { ...k, revision: 2, basis: moved })).toBeNull();
    // Nothing recorded at or before the revision asked for.
    expect(await loadRecallDiagnostics(db, { ...key(), revision: 1, basis })).toBeNull();
  });

  it("reads a stored row that no longer matches the contract as none", async () => {
    const k = key();
    await record(k, 1);
    await db
      .update(schema.planRecallDiagnostics)
      .set({ diagnostics: { recalled: "yes" } })
      .where(
        and(
          eq(schema.planRecallDiagnostics.orgId, k.orgId),
          eq(schema.planRecallDiagnostics.planId, k.planId),
        ),
      );
    expect(await loadRecallDiagnostics(db, { ...k, revision: 1, basis })).toBeNull();
  });

  it("refuses to store diagnostics that don't fit the contract", async () => {
    const tooMany = {
      recalled: true,
      areas: Array.from({ length: 65 }, () => diagnostics.areas[0]),
    };
    await expect(
      record(key(), 1, tooMany as unknown as PrecedentRecallDiagnostics),
    ).rejects.toThrow();
  });
});
