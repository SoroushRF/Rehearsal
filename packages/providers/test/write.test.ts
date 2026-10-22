import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Action } from "@rehearsal/contracts";
import { happyPathBundle } from "@rehearsal/testkit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { classifyResponse, stripeWriter, type WriteTarget, zendeskWriter } from "../src";

const actions = happyPathBundle().manifest.actions;
const byId = (id: string) => {
  const a = actions.find((x) => x.id === id);
  if (!a) throw new Error(`fixture has no ${id}`);
  return a;
};
const refund = byId("refund_001");
const patch = byId("patch_001");
const note = byId("note_001");
const CTX = { world: "operational", tenant: "t1" } as const;

interface Seen {
  method?: string;
  url?: string;
  headers: IncomingMessage["headers"];
  body: string;
}

let server: Server;
let seen: Seen[] = [];
let reply: { status: number; body: string; headers?: Record<string, string>; delayMs?: number } = {
  status: 200,
  body: "{}",
};
let target: WriteTarget;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      setTimeout(() => {
        res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
        res.end(reply.body);
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  target = {
    world: "operational",
    config: { baseUrl: `http://127.0.0.1:${port}`, tenant: "t1", tenantToken: "signed.jwt" },
    authorization: "Bearer sk_test_x",
    timeoutMs: 200,
  };
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  seen = [];
  reply = { status: 200, body: "{}" };
});

describe("classifyResponse", () => {
  it.each([
    [200, "confirmed"],
    [201, "confirmed"],
    [400, "rejected"],
    [402, "rejected"],
    [409, "rejected"],
    [429, "rejected"],
    [500, "unknown"],
    [503, "unknown"],
  ])("%i → %s", (status, kind) => {
    expect(classifyResponse(status, {}, null).kind).toBe(kind);
  });

  it("treats 429 as retryable and reads Retry-After seconds", () => {
    expect(classifyResponse(429, {}, "2")).toMatchObject({ retryable: true, retryAfterMs: 2000 });
    expect(classifyResponse(409, {}, null)).toMatchObject({ retryable: false });
  });
});

describe("stripeWriter", () => {
  const w = () => stripeWriter(target);

  it("prepares the same bytes every time, keyed by the operation key", () => {
    const a = w().prepare(refund, new Map(), "op_1");
    const b = w().prepare(structuredClone(refund), new Map(), "op_1");
    expect(a).toEqual(b);
    expect(a).toMatchObject({ method: "POST", path: "/v1/refunds", encoding: "form" });
    expect(a.headers).toEqual({ "idempotency-key": "op_1" });
    expect(new URLSearchParams(a.body).get("metadata[rehearsal_op]")).toBe("op_1");
    expect(a.body.startsWith("charge=ch_fixture_001&amount=4210&reason=duplicate&")).toBe(true);
  });

  it("refuses actions it doesn't own", () => {
    expect(() => w().prepare(patch, new Map(), "op_1")).toThrow(/stripe can't/);
  });

  it("sends the exact bytes with tenant, auth and idempotency headers", async () => {
    reply = {
      status: 200,
      body: JSON.stringify({ id: "re_1", amount: 4210, status: "succeeded" }),
    };
    const req = w().prepare(refund, new Map(), "op_1");
    const result = await w().dispatch(req, CTX);
    expect(result).toMatchObject({ kind: "confirmed", status: 200, body: { id: "re_1" } });
    const [s] = seen;
    expect(s?.body).toBe(req.body);
    expect(s?.headers["idempotency-key"]).toBe("op_1");
    expect(s?.headers["x-sim-tenant"]).toBe("signed.jwt");
    expect(s?.headers.authorization).toBe("Bearer sk_test_x");
    expect(s?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  it("reports a timeout as unknown, never rejected", async () => {
    reply = { status: 200, body: "{}", delayMs: 400 };
    const result = await w().dispatch(w().prepare(refund, new Map(), "op_1"), CTX);
    expect(result.kind).toBe("unknown");
  });

  it("refuses to write to a world or tenant it isn't bound to", async () => {
    const req = w().prepare(refund, new Map(), "op_1");
    await expect(w().dispatch(req, { world: "planning", tenant: "t1" })).rejects.toThrow(
      /bound to/,
    );
    await expect(w().dispatch(req, { world: "operational", tenant: "t2" })).rejects.toThrow(
      /bound to/,
    );
    expect(seen).toEqual([]);
  });
});

describe("zendeskWriter", () => {
  const w = () => zendeskWriter(target);

  it("reads the updated_stamp for a guarded patch", async () => {
    reply = {
      status: 200,
      body: JSON.stringify({ ticket: { updated_at: "2026-10-01T12:00:05Z" } }),
    };
    expect(await w().preconditions?.(patch, CTX)).toEqual({
      updated_stamp: "2026-10-01T12:00:05Z",
    });
    expect(seen[0]).toMatchObject({ method: "GET", url: "/api/v2/tickets/5531.json" });
    expect(await w().preconditions?.(note, CTX)).toEqual({});
  });

  it("a failed precondition read throws (the executor holds the step)", async () => {
    reply = { status: 404, body: "{}" };
    await expect(w().preconditions?.(patch, CTX)).rejects.toThrow(/404/);
  });

  it("prepares a guarded patch with safe_update and the stamp, in fixed key order", () => {
    const req = w().prepare(patch, new Map(), "op_p", { updated_stamp: "S1" });
    expect(req).toMatchObject({
      method: "PUT",
      path: "/api/v2/tickets/5531.json",
      encoding: "json",
    });
    expect(req.body).toBe('{"ticket":{"priority":"high","safe_update":true,"updated_stamp":"S1"}}');
    expect(() => w().prepare(patch, new Map(), "op_p")).toThrow(/updated_stamp/);
  });

  it("prepares a private note with explicit public:false and the operation marker", () => {
    const req = w().prepare(note, new Map([["refund_001:refund.id", "re_real"]]), "op_n");
    const parsed = JSON.parse(req.body) as {
      ticket: { comment: { body: string; public: boolean } };
    };
    expect(parsed.ticket.comment.public).toBe(false);
    expect(parsed.ticket.comment.body).toContain("re_real");
    expect(parsed.ticket.comment.body).toContain("[rehearsal-op:op_n]");
    expect(() => w().prepare(note, new Map(), "op_n")).toThrow(/unresolved binding/);
  });

  it("maps a 409 UpdateConflict to a non-retryable rejection", async () => {
    reply = { status: 409, body: JSON.stringify({ error: "UpdateConflict" }) };
    const req = w().prepare(patch, new Map(), "op_p", { updated_stamp: "S1" });
    expect(await w().dispatch(req, CTX)).toMatchObject({
      kind: "rejected",
      status: 409,
      retryable: false,
    });
  });

  it("refuses actions it doesn't own", () => {
    expect(() => w().prepare(refund as Action, new Map(), "op")).toThrow(/zendesk can't/);
  });
});
