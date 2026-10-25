import { mkdtempSync, readFileSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthzRuleFile } from "@rehearsal/contracts";
import { describe, expect, it } from "vitest";
import { generateDevCerts } from "../src/dev-certs";
import { createIamServer } from "../src/server";

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

const certs = generateDevCerts(mkdtempSync(join(tmpdir(), "iam-certs-")));
const stranger = generateDevCerts(mkdtempSync(join(tmpdir(), "iam-stranger-")));

function post(
  port: number,
  client: { cert: string | Buffer; key: string | Buffer; ca: string | Buffer },
  body: unknown,
): Promise<{ status?: number; json?: { effect?: string }; error?: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        servername: "localhost",
        method: "POST",
        path: "/v1/decide",
        ca: client.ca,
        cert: client.cert,
        key: client.key,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode,
            json: text ? (JSON.parse(text) as { effect?: string }) : {},
          });
        });
      },
    );
    req.on("error", (error) => resolve({ error: error.message }));
    req.end(payload);
  });
}

describe("mTLS", () => {
  it("answers the API, and drops a stranger or the wrong name before a decision", async () => {
    const log: unknown[] = [];
    let questions = 0;
    const clerk = {
      verify: async () => {
        questions += 1;
        return { userId: "user_a", orgId: "org_1", orgRole: "org:member" as string | null };
      },
    };
    const server = createIamServer({
      cert: readFileSync(certs.serverCert),
      key: readFileSync(certs.serverKey),
      clientCa: readFileSync(certs.ca),
      allowedClients: ["api", "executor"],
      files: new Map([["rehearsal-authz@1", file]]),
      clerk,
      now: () => new Date("2026-10-25T12:00:00.000Z"),
      log: (line) => log.push(line),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    const body = {
      action: "GET /api/plans/:id",
      rule: { id: "rehearsal-authz", version: 1 },
      mode: { kind: "person", token: "sess_a" },
      resource: { orgId: "org_1" },
    };
    try {
      const allowed = await post(
        port,
        {
          cert: readFileSync(certs.apiCert),
          key: readFileSync(certs.apiKey),
          ca: readFileSync(certs.ca),
        },
        body,
      );
      expect(allowed.status).toBe(200);
      expect(allowed.json?.effect).toBe("allow");
      expect(questions).toBe(1);
      expect(log).toHaveLength(1);

      const outsider = await post(
        port,
        {
          cert: readFileSync(stranger.apiCert),
          key: readFileSync(stranger.apiKey),
          ca: readFileSync(stranger.ca),
        },
        body,
      );
      expect(outsider.error).toBeTruthy();
      expect(outsider.status).toBeUndefined();

      const wrongName = await post(
        port,
        {
          cert: readFileSync(certs.serverCert),
          key: readFileSync(certs.serverKey),
          ca: readFileSync(certs.ca),
        },
        body,
      );
      expect(wrongName.status).toBeUndefined();
      expect(questions).toBe(1);
      expect(log).toHaveLength(1);
    } finally {
      server.close();
    }
  });
});
