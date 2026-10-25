import { fileURLToPath } from "node:url";
import { AuthzRuleFile } from "@rehearsal/contracts";
import { describe, expect, it } from "vitest";
import { answerRequest, type ClerkVerifier } from "../src";
import { loadRuleFiles } from "../src/rules";

const NOW = new Date("2026-10-25T12:00:00.000Z");
const SUPPORT = "rehearsal:approve:support_step";
const FINANCE = "rehearsal:approve:finance_step";

const file = AuthzRuleFile.parse({
  id: "rehearsal-authz",
  version: 1,
  rolesFromClerk: {
    "org:owner": "owner",
    "org:finance_lead": "finance_lead",
    "org:support_lead": "support_lead",
    "org:member": "member",
  },
  roles: {
    owner: ["rehearsal:read:plan", FINANCE, SUPPORT],
    finance_lead: ["rehearsal:read:plan", FINANCE, SUPPORT],
    support_lead: ["rehearsal:read:plan", SUPPORT],
    member: ["rehearsal:read:plan"],
  },
  rules: [
    {
      action: "GET /api/plans/:id",
      rbac: { anyOf: ["rehearsal:read:plan"] },
      abac: [{ eq: ["subject.orgId", "resource.orgId"] }],
    },
    {
      action: "run:admit",
      rbac: {},
      abac: [{ eq: ["resource.dualRequired", "false"] }],
    },
  ],
});

const files = new Map([["rehearsal-authz@1", file]]);

function clerk(
  person: Awaited<ReturnType<ClerkVerifier["verify"]>>,
): ClerkVerifier & { tokens: string[] } {
  const tokens: string[] = [];
  return {
    tokens,
    verify: async (token) => {
      tokens.push(token);
      return person;
    },
  };
}

function ask(
  raw: unknown,
  verifier: ClerkVerifier = clerk({ userId: "user_a", orgId: "org_1", orgRole: "org:member" }),
) {
  return answerRequest(raw, { files, clerk: verifier, now: NOW });
}

const read = {
  action: "GET /api/plans/:id",
  rule: { id: "rehearsal-authz", version: 1 },
  mode: { kind: "person", token: "sess_a" },
  resource: { orgId: "org_1" },
};

describe("answerRequest", () => {
  it("allows a member of the same org and logs the matched rule", async () => {
    const answer = await ask(read);
    expect(answer.decision.effect).toBe("allow");
    expect(answer.decision.resource).toEqual({ orgId: "org_1" });
    expect(answer.log).toMatchObject({
      action: "GET /api/plans/:id",
      subject: { userId: "user_a", orgId: "org_1" },
      ruleId: "rehearsal-authz",
      ruleVersion: 1,
      matchedRule: 0,
      effect: "allow",
    });
  });

  it("denies a person from another org", async () => {
    const answer = await ask(
      read,
      clerk({ userId: "user_a", orgId: "org_2", orgRole: "org:owner" }),
    );
    expect(answer.decision.effect).toBe("deny");
    expect(answer.log.matchedRule).toBeNull();
  });

  it("does not call Clerk for a stored-grant question", async () => {
    const verifier = clerk({ userId: "user_a", orgId: "org_1", orgRole: "org:owner" });
    const answer = await ask(
      {
        action: "run:admit",
        rule: { id: "rehearsal-authz", version: 1 },
        mode: { kind: "grants" },
        resource: { dualRequired: false },
      },
      verifier,
    );
    expect(answer.decision.effect).toBe("allow");
    expect(answer.log.subject).toBeNull();
    expect(verifier.tokens).toEqual([]);
  });

  it("denies an unknown rule version, a bad request, a missing org, and a rejected token", async () => {
    expect(
      (await ask({ ...read, rule: { id: "rehearsal-authz", version: 9 } })).decision.reason,
    ).toBe("unknown rule rehearsal-authz@9");
    expect((await ask({ action: 1 })).decision.reason).toBe("bad request");
    expect(
      (await ask(read, clerk({ userId: "user_a", orgId: null, orgRole: "org:member" }))).decision
        .reason,
    ).toBe("no active organization");
    expect((await ask(read, clerk(null))).decision.reason).toBe("unauthenticated");
  });

  it("denies when Clerk throws", async () => {
    const answer = await ask(read, {
      verify: async () => {
        throw new Error("clerk down");
      },
    });
    expect(answer.decision).toMatchObject({ effect: "deny", reason: "error: clerk down" });
  });

  it("loads the shipped rule file", () => {
    const shipped = loadRuleFiles(
      fileURLToPath(new URL("../../../scenarios/authz/", import.meta.url)),
    );
    expect(shipped.get("rehearsal-authz@1")?.version).toBe(1);
  });
});
