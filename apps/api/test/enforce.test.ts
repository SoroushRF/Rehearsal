import { PlanManifest } from "@rehearsal/contracts";
import { planHash } from "@rehearsal/core";
import type { Db } from "@rehearsal/db";
import { billingManifest } from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { approvalFacts, grantFact } from "../src/iam";
import { bearer, fakeIam, finance, member } from "./fake-iam";

const ORG = "org_1";
const PLAN = "plan_1";
const manifest = PlanManifest.parse({ ...billingManifest(PLAN), orgId: ORG });
const hash = planHash(manifest);
const planRow = {
  orgId: ORG,
  planId: PLAN,
  revision: 1,
  planHash: hash,
  manifest,
  createdAt: new Date("2026-10-22T12:00:00.000Z"),
};
const grantRow = {
  id: "grant_1",
  orgId: ORG,
  planId: PLAN,
  revision: 1,
  planHash: hash,
  actorUserId: "user_fin",
  actorSessionId: "sess_user_fin",
  roles: ["finance_lead", "support_lead"],
  grantedAt: new Date("2026-10-22T11:00:00.000Z"),
  expiresAt: new Date("2026-10-22T13:00:00.000Z"),
  revokedAt: null,
  policies: null,
};

/** The first two selects are the plan load. Later selects are runs, then grants. */
function scriptedDb() {
  const writes: string[] = [];
  let selects = 0;
  const db = {
    select() {
      selects += 1;
      const rows = selects <= 2 ? [planRow] : selects === 4 ? [grantRow] : [];
      const chain = {
        from() {
          return chain;
        },
        where() {
          return chain;
        },
        orderBy() {
          return chain;
        },
        limit() {
          return chain;
        },
        // biome-ignore lint/suspicious/noThenProperty: the stub is the thenable Drizzle returns
        then(onFulfilled: (value: unknown[]) => unknown, onRejected?: (error: unknown) => unknown) {
          return Promise.resolve(rows).then(onFulfilled, onRejected);
        },
      };
      return chain;
    },
    transaction() {
      writes.push("tx");
      return Promise.reject(new Error("wrote"));
    },
    update() {
      writes.push("update");
      return {
        set() {
          return this;
        },
        where() {
          return this;
        },
        returning() {
          return Promise.reject(new Error("wrote"));
        },
      };
    },
  };
  return { db: db as unknown as Db, writes };
}

function moneyKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(moneyKeys);
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) => [
      ...(key === "amountMinor" || key === "currency" ? [key] : []),
      ...moneyKeys(inner),
    ]);
  }
  return [];
}

describe("approval facts", () => {
  it("sends permissions and dualRequired, never an amount", () => {
    const facts = approvalFacts(manifest, []);
    expect(facts.dualRequired).toBe(false);
    expect(facts.requiredPermissions.length).toBeGreaterThan(0);
    expect(facts.requiredPermissions.every((p) => p.startsWith("rehearsal:"))).toBe(true);
    expect(moneyKeys(facts)).toEqual([]);
  });

  it("does not copy roles onto a grant fact", () => {
    const fact = grantFact({
      id: "grant_1",
      orgId: ORG,
      planId: PLAN,
      revision: 1,
      planHash: hash,
      actorUserId: "user_fin",
      actorSessionId: "sess",
      roles: ["finance_lead"],
      grantedAt: "2026-10-22T11:00:00.000Z",
      expiresAt: "2026-10-22T13:00:00.000Z",
      revokedAt: null,
    });
    expect(fact).not.toHaveProperty("permissions");
    expect(fact).not.toHaveProperty("roles");
    expect(moneyKeys(fact)).toEqual([]);
  });
});

describe("person routes ask IAM and do not write on a refusal", () => {
  const approve = async (
    iam: ReturnType<typeof fakeIam>,
    person: ReturnType<typeof finance> | null,
  ) => {
    const { db, writes } = scriptedDb();
    const app = buildApp({
      webRoot: null,
      approvals: { db, iam, policies: [] },
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/plans/${PLAN}/approvals`,
        headers: person ? bearer(person) : {},
        payload: { revision: 1, planHash: hash },
      });
      return { res, writes, iam };
    } finally {
      await app.close();
    }
  };

  it("answers 404 for another org and stores nothing", async () => {
    const iam = fakeIam([finance("org_other")]);
    const { res, writes } = await approve(iam, finance("org_other"));
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "plan_not_found" });
    expect(writes).toEqual([]);
    expect(iam.requests.some((r) => r.action === "run:admit")).toBe(false);
  });

  it("answers 403 when the permission is missing and stores nothing", async () => {
    const iam = fakeIam([member(ORG)]);
    const { res, writes } = await approve(iam, member(ORG));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden" });
    expect(writes).toEqual([]);
  });

  it("answers 503 when IAM is down and stores nothing", async () => {
    const iam = fakeIam([finance(ORG)], { down: true });
    const { res, writes } = await approve(iam, finance(ORG));
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "iam_unavailable" });
    expect(writes).toEqual([]);
  });

  it("answers 503 when the decision echoes a different action and stores nothing", async () => {
    const iam = fakeIam([finance(ORG)], {
      warp: (decision) => ({ ...decision, action: "GET /api/plans" }),
    });
    const { res, writes } = await approve(iam, finance(ORG));
    expect(res.statusCode).toBe(503);
    expect(writes).toEqual([]);
  });
});

describe("apply asks run:admit with stored grants", () => {
  it("does not queue when the grant has roles but no permissions", async () => {
    const { db, writes } = scriptedDb();
    const iam = fakeIam([finance(ORG)], { now: () => new Date("2026-10-22T12:00:00.000Z") });
    const app = buildApp({
      webRoot: null,
      apply: {
        db,
        boss: {} as never,
        iam,
        policies: [],
        now: () => new Date("2026-10-22T12:00:00.000Z"),
      },
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/plans/${PLAN}/apply`,
        headers: bearer(finance(ORG)),
        payload: { revision: 1, planHash: hash },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "forbidden" });
      expect(writes).toEqual([]);
      const admit = iam.requests.find((r) => r.action === "run:admit");
      expect(admit?.mode).toEqual({ kind: "grants" });
      expect(admit?.resource).toMatchObject({
        orgId: ORG,
        planHash: hash,
        revision: 1,
        dualRequired: false,
      });
      const grants = admit?.resource.grants as Record<string, unknown>[];
      expect(grants).toHaveLength(1);
      expect(grants[0]).not.toHaveProperty("permissions");
      expect(grants[0]).not.toHaveProperty("roles");
      expect(moneyKeys(admit?.resource)).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
