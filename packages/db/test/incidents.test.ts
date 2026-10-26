import { randomUUID } from "node:crypto";
import type { IncidentDraft } from "@rehearsal/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, insertIncident, listIncidents, loadIncident, migrateDb } from "../src";

const draft: IncidentDraft = {
  kind: "duplicate_charge",
  title: "Charged twice in September",
  description: "Customers report two charges for the same September invoice.",
  window: { createdGte: "2026-09-01T00:00:00.000Z", createdLt: "2026-10-01T00:00:00.000Z" },
};

// Needs a real Postgres: `pnpm infra:up` then `DB_TESTS=1 pnpm --filter @rehearsal/db test`.
describe.skipIf(!process.env.DB_TESTS)("incidents (real Postgres)", () => {
  const url = process.env.DATABASE_URL ?? "postgres://rehearsal:rehearsal@localhost:5432/rehearsal";
  const db = createDb(url);
  beforeAll(() => migrateDb(db));
  afterAll(() => db.$client.end());

  it("files an incident with a kind-coded ID and reads it back for its own org only", async () => {
    const org = `org_${randomUUID()}`;
    const stored = await insertIncident(db, org, "user_1", draft);
    expect(stored.incidentId).toMatch(/^INC-BILL-\d{4}$/);
    expect(stored).toMatchObject({ ...draft, orgId: org });
    expect(await loadIncident(db, org, stored.incidentId)).toEqual(stored);
    expect(await loadIncident(db, `org_${randomUUID()}`, stored.incidentId)).toBeUndefined();
    expect((await listIncidents(db, org)).map((i) => i.incidentId)).toEqual([stored.incidentId]);
  });

  it("retries a taken ID instead of overwriting the row that has it", async () => {
    const org = `org_${randomUUID()}`;
    const n = 1000 + Math.floor(Math.random() * 9000);
    const first = await insertIncident(db, org, "user_1", draft, () => n);
    const picks = [n, (n + 1) % 10_000];
    const second = await insertIncident(
      db,
      org,
      "user_1",
      { ...draft, title: "Another one" },
      () => picks.shift() as number,
    );
    expect(second.incidentId).not.toBe(first.incidentId);
    expect((await loadIncident(db, org, first.incidentId))?.title).toBe(draft.title);
  });

  it("never allocates the built-in incident ID", async () => {
    const next = 1000 + Math.floor(Math.random() * 9000);
    const picks = [927, 927, next];
    const stored = await insertIncident(
      db,
      `org_${randomUUID()}`,
      "user_1",
      draft,
      () => picks.shift() as number,
    );
    expect(stored.incidentId).toBe(`INC-BILL-${next}`);
  });
});
