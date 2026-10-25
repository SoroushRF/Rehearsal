import { AuthzRuleFile } from "@rehearsal/contracts";
import { describe, expect, it } from "vitest";
import raw from "../../../scenarios/authz/rehearsal-authz.v1.json" with { type: "json" };
import {
  type ClerkOrganizationApi,
  type ClerkOrgClient,
  type ClerkVerifier,
  clerkOrgClientFromBackend,
} from "../src/clerk";
import { answerMembership } from "../src/members";

const file = AuthzRuleFile.parse(raw);
const files = new Map([["rehearsal-authz@1", file]]);
const rule = { id: "rehearsal-authz", version: 1 } as const;

function verifier(
  orgRole: string,
  extras: { orgId?: string | null; userId?: string; sessionId?: string | null } = {},
): ClerkVerifier {
  return {
    verify: async () => ({
      userId: extras.userId ?? "user_own",
      orgId: extras.orgId === undefined ? "org_real" : extras.orgId,
      orgRole,
      sessionId: extras.sessionId === undefined ? "sess_own" : extras.sessionId,
    }),
  };
}

function directory(seed: { userId: string; role: string }[] = []) {
  const invites: {
    organizationId: string;
    emailAddress: string;
    role: string;
    inviterUserId: string;
  }[] = [];
  const updates: { organizationId: string; userId: string; role: string }[] = [];
  const lists: string[] = [];
  const orgs: ClerkOrgClient = {
    async listMemberships(organizationId) {
      lists.push(organizationId);
      return seed;
    },
    async createInvitation(input) {
      invites.push(input);
    },
    async updateMembershipRole(input) {
      updates.push(input);
    },
  };
  return { orgs, invites, updates, lists };
}

describe("answerMembership", () => {
  it("invites into the organization the token verified, as the verified user", async () => {
    const book = directory();
    const result = await answerMembership(
      {
        kind: "invite",
        token: "tok",
        rule,
        email: "new@example.com",
        role: "org:member",
      },
      { files, clerk: verifier("org:owner"), orgs: book.orgs },
    );
    expect(result).toEqual({
      ok: true,
      kind: "invite",
      orgId: "org_real",
      role: "org:member",
      email: "new@example.com",
    });
    expect(book.invites).toEqual([
      {
        organizationId: "org_real",
        emailAddress: "new@example.com",
        role: "org:member",
        inviterUserId: "user_own",
      },
    ]);
    expect(book.lists).toEqual([]);
    expect(book.updates).toEqual([]);
  });

  it("refuses an organization id on the command and does not call Clerk", async () => {
    const book = directory();
    let verifications = 0;
    const clerk: ClerkVerifier = {
      verify: async () => {
        verifications += 1;
        return { userId: "user_own", orgId: "org_real", orgRole: "org:owner", sessionId: "sess" };
      },
    };
    const result = await answerMembership(
      {
        kind: "invite",
        token: "tok",
        rule,
        email: "new@example.com",
        role: "org:member",
        organizationId: "org_other",
      },
      { files, clerk, orgs: book.orgs },
    );
    expect(result).toEqual({ ok: false, error: "bad_request" });
    expect(verifications).toBe(0);
    expect(book.invites).toEqual([]);
  });

  it.each(["org:finance_lead", "org:support_lead", "org:member", "org:admin"])(
    "does not invite for %s, because that role lacks rehearsal:invite:member",
    async (orgRole) => {
      const book = directory();
      const result = await answerMembership(
        { kind: "invite", token: "tok", rule, email: "new@example.com", role: "org:member" },
        { files, clerk: verifier(orgRole), orgs: book.orgs },
      );
      expect(result).toEqual({ ok: false, error: "forbidden" });
      expect(book.invites).toEqual([]);
      expect(book.lists).toEqual([]);
    },
  );

  it.each(["org:admin", "owner", "admin", "org:custom"])(
    "rejects %s before any Clerk write",
    async (role) => {
      const book = directory([{ userId: "user_own", role: "org:owner" }]);
      const invite = await answerMembership(
        { kind: "invite", token: "tok", rule, email: "new@example.com", role },
        { files, clerk: verifier("org:owner"), orgs: book.orgs },
      );
      const change = await answerMembership(
        { kind: "set_role", token: "tok", rule, userId: "user_mem", role },
        { files, clerk: verifier("org:owner"), orgs: book.orgs },
      );
      expect(invite).toEqual({ ok: false, error: "invalid_role" });
      expect(change).toEqual({ ok: false, error: "invalid_role" });
      expect(book.invites).toEqual([]);
      expect(book.updates).toEqual([]);
      expect(book.lists).toEqual([]);
    },
  );

  it("changes a role inside the verified organization", async () => {
    const book = directory([
      { userId: "user_own", role: "org:owner" },
      { userId: "user_mem", role: "org:member" },
    ]);
    const result = await answerMembership(
      { kind: "set_role", token: "tok", rule, userId: "user_mem", role: "org:finance_lead" },
      { files, clerk: verifier("org:owner"), orgs: book.orgs },
    );
    expect(result).toMatchObject({ ok: true, kind: "set_role", orgId: "org_real" });
    expect(book.lists).toEqual(["org_real"]);
    expect(book.updates).toEqual([
      { organizationId: "org_real", userId: "user_mem", role: "org:finance_lead" },
    ]);
  });

  it("refuses to demote or replace the only owner and does not call Clerk's update", async () => {
    const book = directory([
      { userId: "user_own", role: "org:owner" },
      { userId: "user_mem", role: "org:member" },
    ]);
    for (const role of ["org:finance_lead", "org:support_lead", "org:member"] as const) {
      const result = await answerMembership(
        { kind: "set_role", token: "tok", rule, userId: "user_own", role },
        { files, clerk: verifier("org:owner"), orgs: book.orgs },
      );
      expect(result).toEqual({ ok: false, error: "last_owner" });
    }
    expect(book.updates).toEqual([]);
    expect(book.lists).toEqual(["org_real", "org_real", "org_real"]);
  });

  it("allows a second owner to be demoted, and an owner to keep the owner role", async () => {
    const book = directory([
      { userId: "user_own", role: "org:owner" },
      { userId: "user_two", role: "org:owner" },
    ]);
    const kept = await answerMembership(
      { kind: "set_role", token: "tok", rule, userId: "user_own", role: "org:owner" },
      { files, clerk: verifier("org:owner"), orgs: book.orgs },
    );
    const demoted = await answerMembership(
      { kind: "set_role", token: "tok", rule, userId: "user_two", role: "org:member" },
      { files, clerk: verifier("org:owner"), orgs: book.orgs },
    );
    expect(kept).toMatchObject({ ok: true });
    expect(demoted).toMatchObject({ ok: true });
    expect(book.updates).toEqual([
      { organizationId: "org_real", userId: "user_own", role: "org:owner" },
      { organizationId: "org_real", userId: "user_two", role: "org:member" },
    ]);
  });

  it("does not update a user who is not in the organization", async () => {
    const book = directory([{ userId: "user_own", role: "org:owner" }]);
    const result = await answerMembership(
      { kind: "set_role", token: "tok", rule, userId: "user_missing", role: "org:member" },
      { files, clerk: verifier("org:owner"), orgs: book.orgs },
    );
    expect(result).toEqual({ ok: false, error: "member_not_found" });
    expect(book.updates).toEqual([]);
  });

  it("counts an owner on a later page and still refuses to demote the last one", async () => {
    let updates = 0;
    const first = Array.from({ length: 100 }, (_, index) => ({
      role: "org:member",
      publicUserData: { userId: `user_${index}` },
    }));
    const orgs = clerkOrgClientFromBackend({
      async getOrganizationMembershipList({ organizationId, offset }) {
        expect(organizationId).toBe("org_real");
        if (offset === 0) return { data: first, totalCount: 101 };
        return {
          data: [{ role: "org:owner", publicUserData: { userId: "user_own" } }],
          totalCount: 101,
        };
      },
      async createOrganizationInvitation() {},
      async updateOrganizationMembership() {
        updates += 1;
      },
    });
    const result = await answerMembership(
      { kind: "set_role", token: "tok", rule, userId: "user_own", role: "org:member" },
      { files, clerk: verifier("org:owner"), orgs },
    );
    expect(result).toEqual({ ok: false, error: "last_owner" });
    expect(updates).toBe(0);
  });

  it("does not change a role when the membership list stops early", async () => {
    let updates = 0;
    const orgs = clerkOrgClientFromBackend({
      async getOrganizationMembershipList() {
        return {
          data: [{ role: "org:member", publicUserData: { userId: "user_mem" } }],
          totalCount: 3,
        };
      },
      async createOrganizationInvitation() {},
      async updateOrganizationMembership() {
        updates += 1;
      },
    });
    const result = await answerMembership(
      { kind: "set_role", token: "tok", rule, userId: "user_mem", role: "org:support_lead" },
      { files, clerk: verifier("org:owner"), orgs },
    );
    expect(result).toEqual({ ok: false, error: "clerk_unavailable" });
    expect(updates).toBe(0);
  });

  it("is unauthenticated, or has no organization, without calling Clerk's organization API", async () => {
    const book = directory();
    const rejected = await answerMembership(
      { kind: "invite", token: "tok", rule, email: "new@example.com", role: "org:member" },
      { files, clerk: { verify: async () => null }, orgs: book.orgs },
    );
    const noOrg = await answerMembership(
      { kind: "invite", token: "tok", rule, email: "new@example.com", role: "org:member" },
      { files, clerk: verifier("org:owner", { orgId: null }), orgs: book.orgs },
    );
    const noSession = await answerMembership(
      { kind: "invite", token: "tok", rule, email: "new@example.com", role: "org:member" },
      { files, clerk: verifier("org:owner", { sessionId: null }), orgs: book.orgs },
    );
    expect(rejected).toEqual({ ok: false, error: "unauthenticated" });
    expect(noOrg).toEqual({ ok: false, error: "no_active_organization" });
    expect(noSession).toEqual({ ok: false, error: "unauthenticated" });
    expect(book.invites).toEqual([]);
  });

  it("does not verify a token for a rule file it has not loaded", async () => {
    let verifications = 0;
    const result = await answerMembership(
      {
        kind: "invite",
        token: "tok",
        rule: { id: "rehearsal-authz", version: 9 },
        email: "new@example.com",
        role: "org:member",
      },
      {
        files,
        clerk: {
          verify: async () => {
            verifications += 1;
            return null;
          },
        },
        orgs: directory().orgs,
      },
    );
    expect(result).toEqual({ ok: false, error: "unknown_rule" });
    expect(verifications).toBe(0);
  });
});

describe("clerkOrgClientFromBackend", () => {
  it("reads later pages and stops when a page repeats a user", async () => {
    const offsets: number[] = [];
    const api: ClerkOrganizationApi = {
      async getOrganizationMembershipList({ offset }) {
        offsets.push(offset);
        if (offset === 0) {
          return {
            data: Array.from({ length: 100 }, (_, index) => ({
              role: index === 0 ? "org:owner" : "org:member",
              publicUserData: { userId: `user_${index}` },
            })),
            totalCount: 101,
          };
        }
        return {
          data: [{ role: "org:owner", publicUserData: { userId: "user_0" } }],
          totalCount: 101,
        };
      },
      async createOrganizationInvitation() {},
      async updateOrganizationMembership() {},
    };
    await expect(clerkOrgClientFromBackend(api).listMemberships("org_real")).rejects.toThrow(
      /repeated/,
    );
    expect(offsets).toEqual([0, 100]);
  });
});
