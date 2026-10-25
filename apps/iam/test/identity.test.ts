import { AuthzRuleFile } from "@rehearsal/contracts";
import { describe, expect, it } from "vitest";
import type { ClerkVerifier } from "../src/clerk";
import { answerIdentity } from "../src/identity";

const file = AuthzRuleFile.parse({
  id: "rehearsal-authz",
  version: 1,
  rolesFromClerk: { "org:member": "member", "org:support_lead": "support_lead" },
  roles: {
    owner: ["rehearsal:read:plan"],
    finance_lead: ["rehearsal:read:plan"],
    support_lead: ["rehearsal:read:plan", "rehearsal:apply:plan"],
    member: ["rehearsal:read:plan"],
  },
  rules: [],
});

const files = new Map([["rehearsal-authz@1", file]]);

function clerk(person: Awaited<ReturnType<ClerkVerifier["verify"]>>): ClerkVerifier {
  return { verify: async () => person };
}

const rule = { id: "rehearsal-authz", version: 1 };

describe("answerIdentity", () => {
  it("returns the verified person and the permissions for their Clerk role", async () => {
    const answer = await answerIdentity(
      { token: "sess_a", rule },
      {
        files,
        clerk: clerk({
          userId: "user_a",
          orgId: "org_1",
          orgRole: "org:support_lead",
          sessionId: "sess_a",
        }),
      },
    );
    expect(answer).toEqual({
      ok: true,
      userId: "user_a",
      orgId: "org_1",
      clerkRole: "org:support_lead",
      permissions: ["rehearsal:read:plan", "rehearsal:apply:plan"],
      sessionId: "sess_a",
    });
  });

  it("gives an unmapped Clerk role no permissions", async () => {
    const answer = await answerIdentity(
      { token: "sess_a", rule },
      {
        files,
        clerk: clerk({
          userId: "user_a",
          orgId: "org_1",
          orgRole: "org:admin",
          sessionId: "sess_a",
        }),
      },
    );
    expect(answer).toMatchObject({ ok: true, clerkRole: "org:admin", permissions: [] });
  });

  it.each([
    ["a token Clerk rejects", clerk(null)],
    [
      "a person with no session",
      clerk({ userId: "user_a", orgId: "org_1", orgRole: "org:member" }),
    ],
  ])("is unauthenticated for %s", async (_label, verifier) => {
    const answer = await answerIdentity({ token: "nope", rule }, { files, clerk: verifier });
    expect(answer).toEqual({ ok: false, error: "unauthenticated" });
  });

  it("refuses a session with no active organization", async () => {
    const answer = await answerIdentity(
      { token: "sess_a", rule },
      {
        files,
        clerk: clerk({ userId: "user_a", orgId: null, orgRole: null, sessionId: "sess_a" }),
      },
    );
    expect(answer).toEqual({ ok: false, error: "no_active_organization" });
  });

  it("does not answer for a rule file it has not loaded", async () => {
    const answer = await answerIdentity(
      { token: "sess_a", rule: { id: "rehearsal-authz", version: 9 } },
      {
        files,
        clerk: clerk({
          userId: "user_a",
          orgId: "org_1",
          orgRole: "org:member",
          sessionId: "sess_a",
        }),
      },
    );
    expect(answer).toEqual({ ok: false, error: "unknown_rule" });
  });
});
