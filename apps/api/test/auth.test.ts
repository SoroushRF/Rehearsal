import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app";
import {
  type Authenticate,
  bearerReviewer,
  clerkFromEnv,
  reviewerFrom,
  type SessionClaims,
} from "../src/auth";

const claims = (orgRole: string | null, orgId: string | null = "org_1"): SessionClaims => ({
  userId: "user_1",
  sessionId: "sess_1",
  orgId,
  orgRole,
});

describe("reviewerFrom", () => {
  it.each([
    ["org:finance_lead", ["finance_lead", "support_lead"]],
    ["org:support_lead", ["support_lead"]],
    ["org:member", []],
    ["org:admin", []],
    [null, []],
  ])("maps Clerk role %s to %j", (role, roles) => {
    expect(reviewerFrom(claims(role))).toEqual({
      userId: "user_1",
      orgId: "org_1",
      sessionId: "sess_1",
      roles,
    });
  });

  it("refuses a session without an active organization", () => {
    expect(reviewerFrom(claims("org:finance_lead", null))).toBeNull();
    expect(reviewerFrom(null)).toBeNull();
  });
});

describe("bearerReviewer", () => {
  async function resolve(headers: Record<string, string>, authenticate: Authenticate) {
    const app = buildApp({ webRoot: null, reviewer: bearerReviewer(authenticate) });
    try {
      return await app.inject({ method: "GET", url: "/api/me", headers });
    } finally {
      await app.close();
    }
  }

  it("verifies only the bearer token, never the cookie", async () => {
    const authenticate = vi.fn<Authenticate>(async () => claims("org:support_lead"));
    const res = await resolve(
      { authorization: "Bearer tok_123", cookie: "__session=cookie_tok" },
      authenticate,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: "user_1", orgId: "org_1", roles: ["support_lead"] });

    const [request] = authenticate.mock.calls[0] ?? [];
    expect(request?.headers.get("authorization")).toBe("Bearer tok_123");
    expect(request?.headers.get("cookie")).toBeNull();
  });

  it.each([
    ["no credentials", {}],
    ["only Clerk's cookie", { cookie: "__session=cookie_tok" }],
    ["a non-bearer header", { authorization: "Basic dXNlcjpwYXNz" }],
    ["an empty bearer token", { authorization: "Bearer " }],
  ])("is unauthenticated with %s, without asking Clerk", async (_label, headers) => {
    const authenticate = vi.fn<Authenticate>(async () => claims("org:finance_lead"));
    expect((await resolve(headers, authenticate)).statusCode).toBe(401);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("is unauthenticated when Clerk rejects the token", async () => {
    expect((await resolve({ authorization: "Bearer bad" }, async () => null)).statusCode).toBe(401);
  });

  it("applies to the plan routes too", async () => {
    const app = buildApp({
      webRoot: null,
      plans: { db: {} as never, auth: bearerReviewer(async () => claims("org:support_lead")) },
    });
    try {
      const res = await app.inject({ method: "GET", url: "/api/plans" });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe("clerkFromEnv", () => {
  it("is off unless both keys are set", () => {
    expect(clerkFromEnv({})).toBeUndefined();
    expect(clerkFromEnv({ CLERK_SECRET_KEY: "sk_test_x" })).toBeUndefined();
    expect(clerkFromEnv({ CLERK_PUBLISHABLE_KEY: "pk_test_x" })).toBeUndefined();
  });

  it("without Clerk, /api/me says nobody is signed in", async () => {
    const app = buildApp({ webRoot: null });
    try {
      expect((await app.inject({ method: "GET", url: "/api/me" })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
