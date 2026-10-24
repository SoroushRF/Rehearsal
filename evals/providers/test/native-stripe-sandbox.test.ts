import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkSandbox,
  SANDBOX_LABEL,
  type SandboxRun,
  sandboxClient,
  sandboxKey,
  seedSandbox,
} from "../../../scripts/stripe-sandbox/sandbox";

const KEY = "sk_test_51Fake";

/**
 * A small in-memory stand-in for native Stripe test mode: customers, charges, refunds, one account,
 * cursor pagination. It records every request so the tests can see what was sent.
 */
function fakeStripe(options: { livemode?: boolean; account?: string } = {}) {
  const requests: { method: string; path: string; headers: Headers; body: string }[] = [];
  const records = new Map<string, Record<string, unknown>>();
  let n = 0;
  let clock = 1_790_000_000;
  const livemode = options.livemode ?? false;
  const metadata = (form: URLSearchParams) => {
    const out: Record<string, string> = {};
    for (const [k, v] of form) {
      const m = /^metadata\[(.+)\]$/.exec(k);
      if (m?.[1]) out[m[1]] = v;
    }
    return out;
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    const body = String(init?.body ?? "");
    requests.push({ method, path: url.pathname + url.search, headers, body });
    if (headers.get("authorization") !== `Bearer ${KEY}`) {
      return Response.json({ error: { message: "Invalid API Key" } }, { status: 401 });
    }
    const form = new URLSearchParams(body);
    const parts = url.pathname.split("/").filter(Boolean);
    if (method === "GET" && url.pathname === "/v1/account") {
      return Response.json({ id: options.account ?? "acct_fake", object: "account" });
    }
    if (method === "POST") {
      const kind = parts[1];
      const prefix = { customers: "cus", charges: "ch", refunds: "re" }[kind ?? ""];
      if (!prefix) return Response.json({ error: { message: "no route" } }, { status: 404 });
      const id = `${prefix}_fake${++n}`;
      const record: Record<string, unknown> = { id, livemode, metadata: metadata(form) };
      if (kind === "charges") {
        Object.assign(record, {
          object: "charge",
          amount: Number(form.get("amount")),
          amount_refunded: 0,
          currency: form.get("currency"),
          customer: form.get("customer"),
          status: "succeeded",
          invoice: null,
          created: clock++,
        });
      }
      if (kind === "refunds") {
        const charge = records.get(String(form.get("charge")));
        if (charge) charge.amount_refunded = Number(form.get("amount"));
      }
      records.set(id, record);
      return Response.json(record);
    }
    if (parts[1] === "charges" && parts.length === 2) {
      const all = [...records.values()]
        .filter((r) => r.object === "charge" && r.customer === url.searchParams.get("customer"))
        .sort((a, b) => Number(b.created) - Number(a.created));
      const after = url.searchParams.get("starting_after");
      const start = after ? all.findIndex((r) => r.id === after) + 1 : 0;
      const limit = Number(url.searchParams.get("limit") ?? 10);
      const data = all.slice(start, start + limit);
      return Response.json({ object: "list", data, has_more: start + limit < all.length });
    }
    const record = records.get(parts[2] ?? "");
    return record
      ? Response.json(record)
      : Response.json({ error: { message: "No such object" } }, { status: 404 });
  };
  return { fetch, requests, records };
}

const env = { STRIPE_SANDBOX_SECRET_KEY: KEY };

describe("native Stripe sandbox gate (T1.24)", () => {
  it("accepts only a test-mode secret key", () => {
    expect(sandboxKey(env)).toBe(KEY);
    for (const key of ["", "sk_live_51abc", "rk_test_51abc", "pk_test_51abc", "sk_test_"]) {
      expect(() => sandboxKey({ STRIPE_SANDBOX_SECRET_KEY: key })).toThrow();
    }
  });

  it("seeds a labelled run and passes every check on a consistent account", async () => {
    const stripe = fakeStripe();
    const client = sandboxClient(env, stripe.fetch);
    const run = await seedSandbox(client, "run00001");
    expect(run.chargeIds).toHaveLength(3);
    const checks = await checkSandbox(client, run, env);
    expect(checks.map((c) => [c.name, c.ok])).toEqual([
      ["account binding", true],
      ["livemode false on every record", true],
      ["identity, amount and currency through the reader", true],
      ["complete enumeration across pages", true],
    ]);
    // Every write carried its idempotency key and the run's label.
    const posts = stripe.requests.filter((r) => r.method === "POST");
    expect(posts.map((r) => r.headers.get("idempotency-key"))).toEqual([
      "run00001-customer",
      "run00001-charge-0",
      "run00001-charge-1",
      "run00001-charge-2",
      "run00001-refund",
    ]);
    for (const r of posts) {
      expect(new URLSearchParams(r.body).get(`metadata[${SANDBOX_LABEL}]`)).toBe("run00001");
    }
  });

  it("never sends an Era tenant header, and pins the API version when asked", async () => {
    const stripe = fakeStripe();
    const pinned = { ...env, STRIPE_SANDBOX_API_VERSION: "2024-06-20" };
    const client = sandboxClient(pinned, stripe.fetch);
    await checkSandbox(client, await seedSandbox(client, "run00002"), pinned);
    expect(stripe.requests.length).toBeGreaterThan(10);
    for (const r of stripe.requests) {
      expect(r.headers.has("x-sim-tenant")).toBe(false);
      expect(r.headers.get("stripe-version")).toBe("2024-06-20");
    }
  });

  it("fails the account check for another account, and refuses live-mode answers", async () => {
    const stripe = fakeStripe();
    const client = sandboxClient(env, stripe.fetch);
    const run = await seedSandbox(client, "run00003");
    const pinned = { ...env, STRIPE_SANDBOX_ACCOUNT: "acct_expected" };
    const [binding] = await checkSandbox(client, run, pinned);
    expect(binding).toEqual({
      name: "account binding",
      ok: false,
      detail: "key is for acct_fake, expected acct_expected",
    });
    const moved: SandboxRun = { ...run, accountId: "acct_other" };
    expect((await checkSandbox(client, moved, env))[0]?.ok).toBe(false);

    const live = sandboxClient(env, fakeStripe({ livemode: true }).fetch);
    await expect(seedSandbox(live, "run00004")).rejects.toThrow("answered in live mode");
  });

  it("reports a record that doesn't read back as sent instead of passing", async () => {
    const stripe = fakeStripe();
    const client = sandboxClient(env, stripe.fetch);
    const run = await seedSandbox(client, "run00005");
    const changed = stripe.records.get(run.chargeIds[0] ?? "");
    if (changed) changed.currency = "usd";
    const checks = await checkSandbox(client, run, env);
    expect(checks.find((c) => !c.ok)?.detail).toBe(`${run.chargeIds[0]} is 4210 usd`);
  });
});

// The real run: only with STRIPE_SANDBOX=1 and an sk_test_ key in .env.stripe-sandbox.
const SANDBOX_FILE = new URL("../../../.env.stripe-sandbox", import.meta.url);
const NATIVE = process.env.STRIPE_SANDBOX === "1" && existsSync(SANDBOX_FILE);

describe.skipIf(!NATIVE)("native Stripe test mode", () => {
  it("passes every check on a fresh labelled run", { timeout: 60_000 }, async () => {
    process.loadEnvFile(SANDBOX_FILE);
    const client = sandboxClient();
    const run = await seedSandbox(client, `t124${Date.now().toString(36)}`);
    const checks = await checkSandbox(client, run);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });
});
