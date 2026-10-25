import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthzRuleFile } from "@rehearsal/contracts";
import { describe, expect, it } from "vitest";
import { generateDevCerts } from "../../iam/src/dev-certs";
import { createIamServer } from "../../iam/src/server";
import { AUTHZ_RULE, createIamClient } from "../src/iam";

const file = AuthzRuleFile.parse({
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
});

describe("IAM mTLS client", () => {
  it("verifies IAM's server certificate and accepts an echoed allow", async () => {
    const certs = generateDevCerts(mkdtempSync(join(tmpdir(), "api-iam-")));
    const server = createIamServer({
      cert: readFileSync(certs.serverCert),
      key: readFileSync(certs.serverKey),
      clientCa: readFileSync(certs.ca),
      allowedClients: ["api"],
      files: new Map([["rehearsal-authz@1", file]]),
      clerk: {
        verify: async (token) =>
          token === "sess_a"
            ? { userId: "user_a", orgId: "org_1", orgRole: "org:member", sessionId: "sess_a" }
            : null,
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    const client = createIamClient({
      url: `https://127.0.0.1:${port}`,
      cert: readFileSync(certs.apiCert),
      key: readFileSync(certs.apiKey),
      ca: readFileSync(certs.ca),
    });
    try {
      const decision = await client.decide({
        action: "GET /api/plans/:id",
        rule: AUTHZ_RULE,
        mode: { kind: "person", token: "sess_a" },
        resource: { orgId: "org_1" },
      });
      expect(decision.kind).toBe("decision");
      if (decision.kind === "decision") expect(decision.decision.effect).toBe("allow");

      const me = await client.identify("sess_a");
      expect(me).toMatchObject({
        kind: "ok",
        person: {
          userId: "user_a",
          orgId: "org_1",
          clerkRole: "org:member",
          permissions: ["rehearsal:read:plan"],
        },
      });

      const stranger = generateDevCerts(mkdtempSync(join(tmpdir(), "api-iam-stranger-")));
      const outsider = createIamClient({
        url: `https://127.0.0.1:${port}`,
        cert: readFileSync(stranger.apiCert),
        key: readFileSync(stranger.apiKey),
        ca: readFileSync(stranger.ca),
      });
      expect(
        (
          await outsider.decide({
            action: "GET /api/plans/:id",
            rule: AUTHZ_RULE,
            mode: { kind: "person", token: "sess_a" },
            resource: { orgId: "org_1" },
          })
        ).kind,
      ).toBe("unavailable");
    } finally {
      server.close();
    }
  });

  it("treats a timed-out answer as unavailable", async () => {
    const certs = generateDevCerts(mkdtempSync(join(tmpdir(), "api-iam-hang-")));
    const server = createIamServer({
      cert: readFileSync(certs.serverCert),
      key: readFileSync(certs.serverKey),
      clientCa: readFileSync(certs.ca),
      allowedClients: ["api"],
      files: new Map([["rehearsal-authz@1", file]]),
      clerk: { verify: () => new Promise(() => {}) },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    const client = createIamClient({
      url: `https://127.0.0.1:${port}`,
      cert: readFileSync(certs.apiCert),
      key: readFileSync(certs.apiKey),
      ca: readFileSync(certs.ca),
      timeoutMs: 200,
    });
    try {
      const decision = await client.decide({
        action: "GET /api/plans/:id",
        rule: AUTHZ_RULE,
        mode: { kind: "person", token: "sess_a" },
        resource: { orgId: "org_1" },
      });
      expect(decision.kind).toBe("unavailable");
    } finally {
      server.close();
    }
  });
});
