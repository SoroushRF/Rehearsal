import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { bearer, fakeIam, finance, member, support } from "./fake-iam";

describe("GET /api/me", () => {
  it("returns the person IAM verified and the permissions from the rule file", async () => {
    const person = support("org_1");
    const app = buildApp({ webRoot: null, iam: fakeIam([person]) });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { ...bearer(person), cookie: "__session=cookie_tok" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        userId: "user_sup",
        orgId: "org_1",
        clerkRole: "org:support_lead",
      });
      expect(body.permissions).toContain("rehearsal:read:plan");
      expect(body.permissions).toContain("rehearsal:apply:plan");
      expect(body.permissions).not.toContain("rehearsal:approve:finance_step");
      expect(body).not.toHaveProperty("roles");
    } finally {
      await app.close();
    }
  });

  it("returns an empty permission list for a Clerk role the rule file does not map", async () => {
    const person = {
      token: "tok_admin",
      userId: "user_admin",
      orgId: "org_1",
      clerkRole: "org:admin",
      sessionId: "sess_admin",
    };
    const app = buildApp({ webRoot: null, iam: fakeIam([person]) });
    try {
      const res = await app.inject({ method: "GET", url: "/api/me", headers: bearer(person) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ clerkRole: "org:admin", permissions: [] });
    } finally {
      await app.close();
    }
  });

  it.each([
    ["no credentials", {}],
    ["only a cookie", { cookie: "__session=cookie_tok" }],
    ["a non-bearer header", { authorization: "Basic dXNlcjpwYXNz" }],
    ["an empty bearer token", { authorization: "Bearer " }],
  ])("is unauthenticated with %s", async (_label, headers) => {
    const app = buildApp({ webRoot: null, iam: fakeIam([finance("org_1")]) });
    try {
      expect((await app.inject({ method: "GET", url: "/api/me", headers })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("is unauthenticated when IAM rejects the token", async () => {
    const app = buildApp({ webRoot: null, iam: fakeIam([]) });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { authorization: "Bearer bad" },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("is 503 when IAM is down, and 401 when no IAM client is configured and no token is sent", async () => {
    const down = buildApp({ webRoot: null, iam: fakeIam([member("org_1")], { down: true }) });
    try {
      const res = await down.inject({
        method: "GET",
        url: "/api/me",
        headers: bearer(member("org_1")),
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await down.close();
    }
    const bare = buildApp({ webRoot: null });
    try {
      expect((await bare.inject({ method: "GET", url: "/api/me" })).statusCode).toBe(401);
    } finally {
      await bare.close();
    }
  });
});
