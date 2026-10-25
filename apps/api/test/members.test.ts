import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthzRuleFile } from "@rehearsal/contracts";
import { describe, expect, it } from "vitest";
import raw from "../../../scenarios/authz/rehearsal-authz.v1.json" with { type: "json" };
import { generateDevCerts } from "../../iam/src/dev-certs";
import { createIamServer } from "../../iam/src/server";
import { buildApp } from "../src/app";
import { AUTHZ_RULE, createIamClient } from "../src/iam";
import { bearer, caller, fakeIam, finance, member, owner, support } from "./fake-iam";

const file = AuthzRuleFile.parse(raw);

describe("member routes", () => {
  it("does not depend on the Clerk backend SDK", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies).not.toHaveProperty("@clerk/backend");
    expect(pkg.devDependencies ?? {}).not.toHaveProperty("@clerk/backend");
  });

  it("invites and changes a role for an owner, using the organization IAM verified", async () => {
    const person = owner("org_real");
    const iam = fakeIam([person]);
    const app = buildApp({ webRoot: null, iam });
    try {
      const invite = await app.inject({
        method: "POST",
        url: "/api/members/invitations",
        headers: bearer(person),
        payload: { email: "new@example.com", role: "org:member" },
      });
      const patch = await app.inject({
        method: "PATCH",
        url: "/api/members/user_mem/role",
        headers: bearer(person),
        payload: { role: "org:finance_lead" },
      });
      expect(invite.statusCode).toBe(201);
      expect(invite.json()).toEqual({ email: "new@example.com", role: "org:member" });
      expect(patch.statusCode).toBe(200);
      expect(patch.json()).toEqual({ userId: "user_mem", role: "org:finance_lead" });
      expect(iam.requests.map((request) => request.action)).toEqual([
        "POST /api/members/invitations",
        "PATCH /api/members/:userId/role",
      ]);
      for (const request of iam.requests) {
        expect(request.resource).toEqual({ orgId: "org_real" });
        expect(request.rule).toEqual(AUTHZ_RULE);
      }
      expect(iam.memberships).toEqual([
        {
          kind: "invite",
          token: person.token,
          email: "new@example.com",
          role: "org:member",
        },
        {
          kind: "set_role",
          token: person.token,
          userId: "user_mem",
          role: "org:finance_lead",
        },
      ]);
      expect(iam.memberships[0]).not.toHaveProperty("orgId");
    } finally {
      await app.close();
    }
  });

  it.each([
    ["finance", finance],
    ["support", support],
    ["member", member],
  ] as const)("%s cannot invite or change a role", async (_label, make) => {
    const person = make("org_1");
    const iam = fakeIam([person]);
    const app = buildApp({ webRoot: null, iam });
    try {
      const invite = await app.inject({
        method: "POST",
        url: "/api/members/invitations",
        headers: bearer(person),
        payload: { email: "new@example.com", role: "org:member", orgId: "org_other" },
      });
      const patch = await app.inject({
        method: "PATCH",
        url: "/api/members/user_mem/role",
        headers: bearer(person),
        payload: { role: "org:owner", orgId: "org_other" },
      });
      expect(invite.statusCode).toBe(403);
      expect(invite.json()).toEqual({ error: "forbidden" });
      expect(patch.statusCode).toBe(403);
      expect(patch.json()).toEqual({ error: "forbidden" });
      expect(iam.memberships).toEqual([]);
      for (const request of iam.requests) expect(request.resource).toEqual({ orgId: "org_1" });
    } finally {
      await app.close();
    }
  });

  it("rejects a body that names an organization, and does not ask IAM to write", async () => {
    const person = owner("org_real");
    const iam = fakeIam([person]);
    const app = buildApp({ webRoot: null, iam });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/members/invitations",
        headers: bearer(person),
        payload: { email: "new@example.com", role: "org:member", orgId: "org_other" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "invalid_request" });
      expect(iam.requests.map((request) => request.resource)).toEqual([{ orgId: "org_real" }]);
      expect(iam.memberships).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it.each(["org:admin", "owner", "org:custom"])(
    "returns 400 for %s and still asks IAM, which refuses before Clerk",
    async (role) => {
      const person = owner("org_real");
      const iam = fakeIam([person]);
      const app = buildApp({ webRoot: null, iam });
      try {
        const res = await app.inject({
          method: "POST",
          url: "/api/members/invitations",
          headers: bearer(person),
          payload: { email: "new@example.com", role },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "invalid_role" });
        expect(iam.memberships).toHaveLength(1);
        expect(Object.hasOwn(file.rolesFromClerk, role)).toBe(false);
      } finally {
        await app.close();
      }
    },
  );

  it("returns 409 when IAM reports that the change would leave no owner", async () => {
    const person = owner("org_real");
    const iam = fakeIam([person], {
      membership: () => ({ kind: "result", result: { ok: false, error: "last_owner" } }),
    });
    const app = buildApp({ webRoot: null, iam });
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/members/user_own/role",
        headers: bearer(person),
        payload: { role: "org:member" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: "last_owner" });
      expect(iam.memberships).toEqual([
        { kind: "set_role", token: person.token, userId: "user_own", role: "org:member" },
      ]);
    } finally {
      await app.close();
    }
  });

  it("is 503 when IAM is down or the decision echoes a different action, and does not ask for a write", async () => {
    const person = owner("org_real");
    const down = fakeIam([person], { down: true });
    const warped = fakeIam([person], {
      warp: (decision) => ({ ...decision, action: "GET /api/plans" }),
    });
    const downApp = buildApp({ webRoot: null, iam: down });
    const warpedApp = buildApp({ webRoot: null, iam: warped });
    try {
      const unavailable = await downApp.inject({
        method: "POST",
        url: "/api/members/invitations",
        headers: bearer(person),
        payload: { email: "new@example.com", role: "org:member" },
      });
      const mismatch = await warpedApp.inject({
        method: "PATCH",
        url: "/api/members/user_mem/role",
        headers: bearer(person),
        payload: { role: "org:member" },
      });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toEqual({ error: "iam_unavailable" });
      expect(mismatch.statusCode).toBe(503);
      expect(mismatch.json()).toEqual({ error: "iam_unavailable" });
      expect(down.memberships).toEqual([]);
      expect(warped.memberships).toEqual([]);
    } finally {
      await downApp.close();
      await warpedApp.close();
    }
  });

  it("is 503 when the write names a different organization than the token", async () => {
    const person = owner("org_real");
    const iam = fakeIam([person], {
      membership: (command) => ({
        kind: "result",
        result:
          command.kind === "invite"
            ? {
                ok: true,
                kind: "invite",
                orgId: "org_other",
                role: command.role,
                email: command.email,
              }
            : { ok: false, error: "forbidden" },
      }),
    });
    const app = buildApp({ webRoot: null, iam });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/members/invitations",
        headers: bearer(person),
        payload: { email: "new@example.com", role: "org:member" },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "iam_unavailable" });
    } finally {
      await app.close();
    }
  });

  it.each([
    ["no credentials", {}],
    ["only a cookie", { cookie: "__session=cookie_tok" }],
  ])("is unauthenticated with %s", async (_label, headers) => {
    const iam = fakeIam([owner("org_real")]);
    const app = buildApp({ webRoot: null, iam });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/members/invitations",
        headers,
        payload: { email: "new@example.com", role: "org:member" },
      });
      expect(res.statusCode).toBe(401);
      expect(iam.memberships).toEqual([]);
      expect(iam.requests).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("is 503 when no IAM client is configured", async () => {
    const app = buildApp({ webRoot: null });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/members/invitations",
        headers: { authorization: "Bearer tok" },
        payload: { email: "new@example.com", role: "org:member" },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "iam_unavailable" });
    } finally {
      await app.close();
    }
  });

  it("refuses an unmapped Clerk role even when the caller is signed in", async () => {
    const admin = caller("org_real", "org:admin", "user_admin");
    const iam = fakeIam([admin]);
    const app = buildApp({ webRoot: null, iam });
    try {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/members/user_mem/role",
        headers: bearer(admin),
        payload: { role: "org:member" },
      });
      expect(res.statusCode).toBe(403);
      expect(iam.memberships).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe("member routes over mTLS", () => {
  it("asks IAM, and IAM calls the fake Clerk client for the verified organization only", async () => {
    const certs = generateDevCerts(mkdtempSync(join(tmpdir(), "members-mtls-")));
    const invites: { organizationId: string; emailAddress: string; role: string }[] = [];
    const updates: { organizationId: string; userId: string; role: string }[] = [];
    const server = createIamServer({
      cert: readFileSync(certs.serverCert),
      key: readFileSync(certs.serverKey),
      clientCa: readFileSync(certs.ca),
      allowedClients: ["api", "executor"],
      files: new Map([["rehearsal-authz@1", file]]),
      clerk: {
        verify: async (token) => {
          if (token === "tok_own") {
            return {
              userId: "user_own",
              orgId: "org_real",
              orgRole: "org:owner",
              sessionId: "sess_own",
            };
          }
          if (token === "tok_fin") {
            return {
              userId: "user_fin",
              orgId: "org_real",
              orgRole: "org:finance_lead",
              sessionId: "sess_fin",
            };
          }
          return null;
        },
      },
      orgs: {
        listMemberships: async (organizationId) => {
          expect(organizationId).toBe("org_real");
          return [{ userId: "user_own", role: "org:owner" }];
        },
        createInvitation: async (input) => {
          invites.push(input);
        },
        updateMembershipRole: async (input) => {
          updates.push(input);
        },
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    const iam = createIamClient({
      url: `https://127.0.0.1:${port}`,
      cert: readFileSync(certs.apiCert),
      key: readFileSync(certs.apiKey),
      ca: readFileSync(certs.ca),
    });
    const app = buildApp({ webRoot: null, iam });
    try {
      const invite = await app.inject({
        method: "POST",
        url: "/api/members/invitations",
        headers: { authorization: "Bearer tok_own" },
        payload: { email: "new@example.com", role: "org:member" },
      });
      const badRole = await app.inject({
        method: "POST",
        url: "/api/members/invitations",
        headers: { authorization: "Bearer tok_own" },
        payload: { email: "new@example.com", role: "org:admin" },
      });
      const financeCall = await app.inject({
        method: "POST",
        url: "/api/members/invitations",
        headers: { authorization: "Bearer tok_fin" },
        payload: { email: "new@example.com", role: "org:member" },
      });
      const demote = await app.inject({
        method: "PATCH",
        url: "/api/members/user_own/role",
        headers: { authorization: "Bearer tok_own" },
        payload: { role: "org:member" },
      });
      expect(invite.statusCode).toBe(201);
      expect(invite.json()).toEqual({ email: "new@example.com", role: "org:member" });
      expect(badRole.statusCode).toBe(400);
      expect(badRole.json()).toEqual({ error: "invalid_role" });
      expect(financeCall.statusCode).toBe(403);
      expect(demote.statusCode).toBe(409);
      expect(demote.json()).toEqual({ error: "last_owner" });
      expect(invites).toEqual([
        {
          organizationId: "org_real",
          emailAddress: "new@example.com",
          role: "org:member",
          inviterUserId: "user_own",
        },
      ]);
      expect(updates).toEqual([]);
    } finally {
      await app.close();
      server.close();
    }
  });
});
