import { precedentScope } from "@rehearsal/memory";
import { expect, it } from "vitest";
import { recallersFromEnv } from "../src/precedents";

const env = {
  SURREAL_AGENT_MEMORY_URL: "https://memory.test",
  SURREAL_AGENT_MEMORY_CONTEXT: "ctx",
  SURREAL_AGENT_MEMORY_READ_KEY: "sp-read",
};

it("is off without memory, and needs the read key, not the API's write key", () => {
  expect(recallersFromEnv({})).toBeNull();
  const { SURREAL_AGENT_MEMORY_READ_KEY: _, ...withoutRead } = env;
  expect(() =>
    recallersFromEnv({ ...withoutRead, SURREAL_AGENT_MEMORY_WRITE_KEY: "sp-write" }),
  ).toThrow(/SURREAL_AGENT_MEMORY_READ_KEY/);
});

it("recalls each org in its own scope, with the read key", async () => {
  const seen: { url: string; auth: string | null; body: unknown }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    seen.push({
      url: String(input),
      auth: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify({ tier: "hybrid", hits: [] }), { status: 200 });
  };
  const recallers = recallersFromEnv(env, { fetch });
  if (!recallers) throw new Error("off");
  expect(recallers("org_a")).toBe(recallers("org_a"));
  expect(recallers("org_a").scope).toBe(precedentScope("rehearsal/precedents", "org_a"));
  expect(recallers("org_b").scope).toBe(precedentScope("rehearsal/precedents", "org_b"));

  await recallers("org_b").recall("billing.duplicate_charge");
  expect(seen).toEqual([
    {
      url: "https://memory.test/api/v1/ctx/query",
      auth: "Bearer sp-read",
      body: expect.objectContaining({ lens: [[precedentScope("rehearsal/precedents", "org_b")]] }),
    },
  ]);
});
