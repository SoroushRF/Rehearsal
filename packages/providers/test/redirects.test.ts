import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { happyPathBundle } from "@rehearsal/testkit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  eraAdmin,
  eraFetch,
  mintTenantToken,
  rehearsalWorkerWorlds,
  stripeReader,
  stripeWriter,
  workerWorlds,
} from "../src";

// Real loopback servers: one that redirects every request, and the destination it points at.
// Mocked fetches can't show what a followed redirect would carry, so these go over HTTP.

interface Seen {
  url?: string;
  headers: IncomingMessage["headers"];
}

const listen = async (handler: Parameters<typeof createServer>[1]) => {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};

let trap: { server: Server; url: string };
let redirector: { server: Server; url: string };
let trapped: Seen[] = [];
let status = 307;

beforeAll(async () => {
  trap = await listen((req, res) => {
    trapped.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ access_token: "jwt", expires_in: 3600, id: "re_1" }));
  });
  redirector = await listen((req, res) => {
    res.writeHead(status, { location: `${trap.url}/operational${req.url}` });
    res.end();
  });
});
afterAll(async () => {
  for (const { server } of [trap, redirector]) {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
beforeEach(() => {
  trapped = [];
  status = 307;
});

const world = () => ({ baseUrl: redirector.url, tenant: "rh-abcd1234", tenantToken: "signed.jwt" });

describe("credentialed requests never follow a redirect (T1.23)", () => {
  it.each([307, 308])("a worker's world request fails on a %i and sends nothing on", async (s) => {
    status = s;
    await expect(eraFetch(world(), "/v1/charges?limit=1")).rejects.toThrow();
    expect(trapped).toEqual([]);
  });

  it.each([307, 308])(
    "a redirected refund POST is an unknown outcome, not followed (%i)",
    async (s) => {
      status = s;
      const refund = happyPathBundle().manifest.actions.find((a) => a.id === "refund_001");
      if (!refund) throw new Error("fixture has no refund_001");
      const writer = stripeWriter({
        world: "operational",
        config: world(),
        authorization: "Bearer sk_test_x",
        timeoutMs: 1000,
      });
      const result = await writer.dispatch(writer.prepare(refund, new Map(), "op_1"), {
        world: "operational",
        tenant: "rh-abcd1234",
      });
      expect(result.kind).toBe("unknown");
      expect(trapped).toEqual([]);
    },
  );

  it("the operator's mint and admin calls don't carry the admin token past a redirect", async () => {
    await expect(mintTenantToken(world(), "rehearsal-admin-fixture")).rejects.toThrow();
    await expect(eraAdmin(world(), "rehearsal-admin-fixture", "/reset")).rejects.toThrow();
    expect(trapped).toEqual([]);
  });

  it("a worker's mint request doesn't carry its secret past a redirect", async () => {
    const env = {
      REHEARSAL_API_URL: redirector.url,
      REHEARSAL_WORKER_SECRET: "rehearsal-secret",
      ERA_STRIPE_REHEARSAL_URL: trap.url,
      ERA_ZENDESK_REHEARSAL_URL: `${trap.url}/zendesk`,
    };
    const token = rehearsalWorkerWorlds("abcd1234", env).stripe.tenantToken as {
      get(): Promise<string>;
    };
    await expect(token.get()).rejects.toThrow(/no valid Era tenant token/);
    const planner = workerWorlds("planner", {
      REHEARSAL_API_URL: redirector.url,
      PLANNER_WORKER_SECRET: "planner-secret",
      ERA_STRIPE_PLANNING_URL: trap.url,
      ERA_ZENDESK_PLANNING_URL: `${trap.url}/zendesk`,
      ERA_TENANT: "t",
    }).stripe.tenantToken as { get(): Promise<string> };
    await expect(planner.get()).rejects.toThrow(/no valid Era tenant token/);
    expect(trapped).toEqual([]);
  });

  it("a native Stripe read doesn't carry its key past a redirect", async () => {
    const reader = stripeReader({
      world: "planning",
      config: { baseUrl: redirector.url, tenant: "native" },
      authorization: "Bearer sk_test_x",
      transport: "native",
    });
    await expect(
      reader.observe(
        { vendor: "stripe", kind: "charge", id: "ch_1" },
        { world: "planning", tenant: "native" },
      ),
    ).rejects.toThrow();
    expect(trapped).toEqual([]);
  });
});
