import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRuleFiles } from "../src/rules";

const minimal = {
  id: "rehearsal-authz",
  version: 1,
  rolesFromClerk: { "org:member": "member" },
  roles: {
    owner: ["rehearsal:read:plan"],
    finance_lead: ["rehearsal:read:plan"],
    support_lead: ["rehearsal:read:plan"],
    member: ["rehearsal:read:plan"],
  },
  rules: [
    {
      action: "GET /api/plans/:id",
      rbac: { anyOf: ["rehearsal:read:plan"] },
      abac: [{ eq: ["subject.orgId", "resource.orgId"] }],
    },
  ],
};

describe("loadRuleFiles", () => {
  it("refuses a duplicate id@version and a file that does not parse", () => {
    const dir = mkdtempSync(join(tmpdir(), "iam-rules-"));
    writeFileSync(join(dir, "a.json"), JSON.stringify(minimal));
    writeFileSync(join(dir, "b.json"), JSON.stringify(minimal));
    expect(() => loadRuleFiles(dir)).toThrow(/duplicate rule file rehearsal-authz@1/);

    const bad = mkdtempSync(join(tmpdir(), "iam-rules-"));
    writeFileSync(join(bad, "nope.json"), "{");
    expect(() => loadRuleFiles(bad)).toThrow();
  });
});
