import { describe, expect, it } from "vitest";
import { AgentMemoryClient, AgentMemoryError } from "../src/client";

type Handler = (url: URL, init: RequestInit) => Response;

function client(handler: Handler, apiKey = "sp-secret-key-123456") {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return handler(url, init);
  };
  return {
    calls,
    memory: new AgentMemoryClient({ url: "https://mem.test//", context: "ctx 1", apiKey, fetch }),
  };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const attr = (id: string) => ({
  id,
  key: "statement",
  value: "v",
  memoryCategory: "knowledge",
  scope: [["rehearsal/precedents/"]],
  supersedes: null,
  supersededBy: null,
  validUntil: null,
  createdAt: "2026-10-24T09:00:00Z",
});

describe("AgentMemoryClient", () => {
  it("sends the bearer key to /api/v1/<context>", async () => {
    const { calls, memory } = client(() => json(201, { path: "rehearsal/" }));
    await memory.registerScope("rehearsal/precedents");
    expect(calls[0]?.url.href).toBe("https://mem.test/api/v1/ctx%201/scopes");
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer sp-secret-key-123456");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ path: "rehearsal/precedents" });
  });

  it("writes triples with the snake_case body /facts expects", async () => {
    const { calls, memory } = client(() =>
      json(200, { mode: "triples", extraction: { attributes: [{ id: "a1", key: "k" }] } }),
    );
    const triples = [{ entity: { type: "concept", name: "precedent:x" }, key: "k", value: "v" }];
    const result = await memory.writeTriples("rehearsal/precedents", triples);
    expect(result.extraction.attributes).toEqual([{ id: "a1", key: "k" }]);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      infer: "triples",
      scopes: [["rehearsal/precedents"]],
      triples,
    });
    expect(new Headers(calls[0]?.init.headers).has("idempotency-key")).toBe(false);
  });

  it("queries facts only, through the lens, with the camelCase body /query expects", async () => {
    const { calls, memory } = client(() =>
      json(200, { tier: "hybrid", hits: [], queryMs: 3, trace: { traceId: "t1" } }),
    );
    const result = await memory.query({ query: "dup", k: 5, lens: [["rehearsal/precedents"]] });
    expect(result.trace?.traceId).toBe("t1");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      query: "dup",
      k: 5,
      lens: [["rehearsal/precedents"]],
      include: ["facts"],
    });
  });

  it("encodes entity names and returns null for a 404", async () => {
    const { calls, memory } = client(() => json(404, { message: "entity does not exist" }));
    expect(await memory.entity("concept", "precedent:a b")).toBeNull();
    expect(await memory.history("concept", "precedent:a b")).toEqual([]);
    expect(calls[0]?.url.pathname).toBe("/api/v1/ctx%201/entities/concept/precedent%3Aa%20b");
    expect(new Headers(calls[0]?.init.headers).has("content-type")).toBe(false);
  });

  it("follows history pages to the end", async () => {
    const { calls, memory } = client((url) =>
      url.searchParams.get("cursor") === "c2"
        ? json(200, { history: [attr("a2")], page: { hasMore: false } })
        : json(200, { history: [attr("a1")], page: { hasMore: true, nextCursor: "c2" } }),
    );
    expect((await memory.history("concept", "precedent:x")).map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(calls).toHaveLength(2);
  });

  it("refuses a history page that says there's more but gives no cursor", async () => {
    const { memory } = client(() => json(200, { history: [], page: { hasMore: true } }));
    await expect(memory.history("concept", "precedent:x")).rejects.toThrow(/no cursor/);
  });

  it("turns a non-2xx into an AgentMemoryError with the status and message, never the key", async () => {
    const { memory } = client(() =>
      json(403, { message: "write scope `rehearsal/` is outside the caller's write region" }),
    );
    const error = await memory.writeTriples("rehearsal", []).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentMemoryError);
    expect(error).toMatchObject({ status: 403, route: "POST /facts" });
    expect(String(error)).toContain("outside the caller's write region");
    expect(String(error)).not.toContain("sp-secret");
  });

  it("keeps plain-text error bodies, trimmed", async () => {
    const { memory } = client(() => new Response(`bad path ${"x".repeat(1000)}`, { status: 422 }));
    const error = (await memory.registerScope("Bad").catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/^POST \/scopes → 422: bad path x+$/);
    expect(error.message.length).toBeLessThan(350);
  });

  it("leaves the query string out of the route it reports", async () => {
    const { memory } = client(() => json(500, { message: "boom" }));
    await expect(memory.history("concept", "precedent:x")).rejects.toMatchObject({
      route: "GET /entities/concept/precedent%3Ax/history",
    });
  });

  it("rejects a response that isn't the shape we rely on", async () => {
    const { memory } = client(() => json(200, { tier: "hybrid", hits: [{ text: "no id" }] }));
    await expect(memory.query({ query: "q", k: 1, lens: [] })).rejects.toThrow();
  });

  it("validates traces", async () => {
    const { memory } = client(() =>
      json(200, {
        id: "t1",
        queryText: "q",
        resolutionTier: "hybrid",
        retrievals: [{ retrievedIds: ["attribute:a1"] }],
      }),
    );
    expect((await memory.trace("t1")).retrievals[0]?.retrievedIds).toEqual(["attribute:a1"]);
  });
});
