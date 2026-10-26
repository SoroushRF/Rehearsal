import { StoredIncident } from "@rehearsal/contracts";
import { createDb, type Db, migrateDb, type PgBoss, PLAN_QUEUE } from "@rehearsal/db";
import { PlanJob } from "@rehearsal/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { bearer, type Caller, fakeIam, member, support } from "./fake-iam";

const draft = {
  kind: "duplicate_charge",
  title: "Charged twice in September",
  description: "Two customers wrote in about a second September charge on one invoice.",
  window: { createdGte: "2026-09-01T00:00:00.000Z", createdLt: "2026-10-01T00:00:00.000Z" },
};

describe("incident routes without a database", () => {
  const app = (me: Caller | null) =>
    buildApp({
      webRoot: null,
      rehearse: { db: {} as Db, boss: {} as PgBoss, iam: fakeIam(me ? [me] : []) },
    });
  const file = (me: Caller | null, payload: unknown) =>
    app(me).inject({
      method: "POST",
      url: "/api/incidents",
      headers: me ? bearer(me) : {},
      payload: payload as object,
    });

  it("lets only a person who may rehearse file an incident", async () => {
    expect((await file(null, draft)).statusCode).toBe(401);
    expect((await file(member("org_1"), draft)).statusCode).toBe(403);
  });

  it("refuses a draft outside the contract or with a backwards window", async () => {
    const me = support("org_1", "user_1");
    expect((await file(me, { ...draft, kind: "delete_everything" })).statusCode).toBe(400);
    expect((await file(me, { ...draft, title: "" })).statusCode).toBe(400);
    const backwards = { createdGte: draft.window.createdLt, createdLt: draft.window.createdGte };
    expect((await file(me, { ...draft, window: backwards })).json()).toEqual({
      error: "invalid_window",
    });
  });

  it("says unavailable without a database", async () => {
    const res = await buildApp({ webRoot: null }).inject({ method: "GET", url: "/api/incidents" });
    expect(res.statusCode).toBe(503);
  });
});

// Needs a real Postgres: `pnpm infra:up` then `DB_TESTS=1 pnpm --filter @rehearsal/api test`.
describe.skipIf(!process.env.DB_TESTS)("filed incidents (real Postgres)", () => {
  const url = process.env.DATABASE_URL ?? "postgres://rehearsal:rehearsal@localhost:5432/rehearsal";
  const db = createDb(url);
  const sent: [string, unknown][] = [];
  const boss = {
    send: async (name: string, data: unknown) => {
      sent.push([name, data]);
      return "11111111-1111-4111-8111-111111111111";
    },
  } as unknown as PgBoss;
  beforeAll(() => migrateDb(db));
  afterAll(() => db.$client.end());

  const appFor = (...people: Caller[]) =>
    buildApp({ webRoot: null, rehearse: { db, boss, iam: fakeIam(people) } });

  it("files, lists, and rehearses an incident with the filed report on the plan job", async () => {
    const me = support(`org_${crypto.randomUUID()}`, "user_1");
    const app = appFor(me);
    const filed = await app.inject({
      method: "POST",
      url: "/api/incidents",
      headers: bearer(me),
      payload: draft,
    });
    expect(filed.statusCode).toBe(201);
    const stored = StoredIncident.parse(filed.json());
    expect(stored).toMatchObject({ ...draft, orgId: me.orgId });

    const list = await app.inject({ method: "GET", url: "/api/incidents", headers: bearer(me) });
    expect(list.json().map((i: StoredIncident) => i.incidentId)).toEqual([stored.incidentId]);

    const res = await app.inject({
      method: "POST",
      url: `/api/incidents/${stored.incidentId}/rehearse`,
      headers: bearer(me),
    });
    expect(res.statusCode).toBe(202);
    const [name, data] = sent.at(-1) ?? [];
    expect(name).toBe(PLAN_QUEUE);
    expect(PlanJob.parse(data)).toMatchObject({
      orgId: me.orgId,
      incidentId: stored.incidentId,
      incident: {
        incidentId: stored.incidentId,
        kind: draft.kind,
        title: draft.title,
        description: draft.description,
        window: draft.window,
      },
    });
  });

  it("keeps an org's incidents from another org, as if they did not exist", async () => {
    const mine = support(`org_${crypto.randomUUID()}`, "user_1");
    const other = support(`org_${crypto.randomUUID()}`, "user_2");
    const app = appFor(mine, other);
    const stored = StoredIncident.parse(
      (
        await app.inject({
          method: "POST",
          url: "/api/incidents",
          headers: bearer(mine),
          payload: draft,
        })
      ).json(),
    );
    const before = sent.length;
    const res = await app.inject({
      method: "POST",
      url: `/api/incidents/${stored.incidentId}/rehearse`,
      headers: bearer(other),
    });
    expect(res.statusCode).toBe(404);
    expect(sent.length).toBe(before);
    const list = await app.inject({ method: "GET", url: "/api/incidents", headers: bearer(other) });
    expect(list.json()).toEqual([]);
  });
});
