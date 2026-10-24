import { type ReadTarget, stripeReader } from "@rehearsal/providers";

/**
 * T1.24: a narrow, opt-in proof against a real Stripe **test-mode** account. It creates a few
 * controlled records under a run-specific metadata label, reads them back with the same reader the
 * planner uses (native auth, pagination and response validation, no Era tenant header), and checks
 * identity, amount and currency, livemode and account binding. Evidence is `native_stripe_test`,
 * never `era_integration`, and never stands in for an operational world (decision 0013, §6).
 *
 * Test-mode refunds can't be undone either, so cleanup leaves the records labelled, not deleted.
 */

export const STRIPE_API = "https://api.stripe.com";
/** Every record a run creates carries this metadata key, with the run ID as its value. */
export const SANDBOX_LABEL = "rehearsal_sandbox";
const AMOUNT = 4210;
const CURRENCY = "cad";
const CHARGES = 3;

/** The key from .env.stripe-sandbox, refused unless it is a test-mode secret key. Never logged. */
export function sandboxKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.STRIPE_SANDBOX_SECRET_KEY;
  if (!key) {
    throw new Error(
      "STRIPE_SANDBOX_SECRET_KEY is not set: put an sk_test_ key in .env.stripe-sandbox",
    );
  }
  if (!/^sk_test_[A-Za-z0-9]+$/.test(key)) {
    throw new Error("STRIPE_SANDBOX_SECRET_KEY must be a test-mode secret key (sk_test_…)");
  }
  return key;
}

export interface SandboxClient {
  get(path: string): Promise<Record<string, unknown>>;
  post(
    path: string,
    form: Record<string, string>,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>>;
  /** For the reader: the same base URL, key, version pin and fetch. */
  target(): ReadTarget;
}

/** A native Stripe client bound to one test key. Every response with a `livemode` must be false. */
export function sandboxClient(
  env: NodeJS.ProcessEnv = process.env,
  doFetch: typeof fetch = fetch,
): SandboxClient {
  const key = sandboxKey(env);
  const headers: Record<string, string> = {};
  if (env.STRIPE_SANDBOX_API_VERSION) headers["stripe-version"] = env.STRIPE_SANDBOX_API_VERSION;
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await doFetch(`${STRIPE_API}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as object), authorization: `Bearer ${key}` },
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const message = (body.error as { message?: string } | undefined)?.message ?? "";
      throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${message}`);
    }
    if (body.livemode === true) throw new Error(`${path} answered in live mode; refusing`);
    return body;
  };
  return {
    get: (path) => call(path),
    post: (path, form, idempotencyKey) =>
      call(path, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "idempotency-key": idempotencyKey,
        },
        body: new URLSearchParams(form).toString(),
      }),
    target: () => ({
      // The reader's binding label only; nothing read here becomes plan evidence.
      world: "planning",
      config: { baseUrl: STRIPE_API, tenant: "native" },
      authorization: `Bearer ${key}`,
      transport: "native",
      fetch: doFetch,
      headers,
      pageSize: 1,
    }),
  };
}

/** What one run created, so `checkSandbox` can read exactly that back. */
export interface SandboxRun {
  runId: string;
  accountId: string;
  customerId: string;
  /** In creation order. The second one is refunded in full. */
  chargeIds: string[];
  refundId: string;
  /** Unix-second window around the charges' `created`, for the customer query. */
  window: { createdGte: string; createdLt: string };
}

/** Create a labelled customer, three charges and one refund. Idempotent per run ID. */
export async function seedSandbox(client: SandboxClient, runId: string): Promise<SandboxRun> {
  if (!/^[a-z0-9]{8,32}$/.test(runId))
    throw new Error("run ID must be 8-32 lowercase letters or digits");
  const label = { [`metadata[${SANDBOX_LABEL}]`]: runId };
  const account = await client.get("/v1/account");
  const customer = await client.post(
    "/v1/customers",
    { email: `sandbox+${runId}@example.com`, source: "tok_visa", ...label },
    `${runId}-customer`,
  );
  const charges: Record<string, unknown>[] = [];
  for (let n = 0; n < CHARGES; n++) {
    charges.push(
      await client.post(
        "/v1/charges",
        {
          amount: String(AMOUNT),
          currency: CURRENCY,
          customer: String(customer.id),
          description: `Rehearsal sandbox ${runId} #${n + 1}`,
          ...label,
        },
        `${runId}-charge-${n}`,
      ),
    );
  }
  const refunded = charges[1];
  if (!refunded) throw new Error("no charge to refund");
  const refund = await client.post(
    "/v1/refunds",
    { charge: String(refunded.id), amount: String(AMOUNT), reason: "duplicate", ...label },
    `${runId}-refund`,
  );
  const created = charges.map((c) => Number(c.created));
  return {
    runId,
    accountId: String(account.id),
    customerId: String(customer.id),
    chargeIds: charges.map((c) => String(c.id)),
    refundId: String(refund.id),
    window: {
      createdGte: new Date(Math.min(...created) * 1000).toISOString(),
      createdLt: new Date((Math.max(...created) + 1) * 1000).toISOString(),
    },
  };
}

export interface SandboxCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Read the run back and check each property the simulator is trusted for. A thrown read is a
 * failed check, not a crash, so the report always says what was and wasn't shown.
 */
export async function checkSandbox(
  client: SandboxClient,
  run: SandboxRun,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SandboxCheck[]> {
  const checks: SandboxCheck[] = [];
  const check = async (name: string, fn: () => Promise<string>) => {
    try {
      checks.push({ name, ok: true, detail: await fn() });
    } catch (err) {
      checks.push({ name, ok: false, detail: (err as Error).message });
    }
  };
  const expect = (ok: boolean, detail: string) => {
    if (!ok) throw new Error(detail);
  };
  const reader = stripeReader(client.target());
  const ctx = { world: "planning", tenant: "native" } as const;

  await check("account binding", async () => {
    const account = await client.get("/v1/account");
    expect(
      account.id === run.accountId,
      `key is for ${account.id}, the run was seeded in ${run.accountId}`,
    );
    const pinned = env.STRIPE_SANDBOX_ACCOUNT;
    expect(!pinned || pinned === account.id, `key is for ${account.id}, expected ${pinned}`);
    return `${account.id}${pinned ? " (pinned)" : ""}`;
  });
  await check("livemode false on every record", async () => {
    const paths = [
      `/v1/customers/${run.customerId}`,
      `/v1/refunds/${run.refundId}`,
      ...run.chargeIds.map((id) => `/v1/charges/${id}`),
    ];
    for (const path of paths) {
      const body = await client.get(path);
      expect(body.livemode === false, `${path} has livemode ${String(body.livemode)}`);
      const metadata = body.metadata as Record<string, unknown> | undefined;
      expect(metadata?.[SANDBOX_LABEL] === run.runId, `${path} isn't labelled ${run.runId}`);
    }
    return `${paths.length} records, all labelled ${SANDBOX_LABEL}=${run.runId}`;
  });
  await check("identity, amount and currency through the reader", async () => {
    for (const [n, id] of run.chargeIds.entries()) {
      const obs = await reader.observe({ vendor: "stripe", kind: "charge", id }, ctx);
      const p = obs.projection;
      expect(
        p.id === id && p.customer === run.customerId,
        `${id} read back as ${String(p.id)}/${String(p.customer)}`,
      );
      expect(
        p.amount === AMOUNT && p.currency === CURRENCY,
        `${id} is ${String(p.amount)} ${String(p.currency)}`,
      );
      const refunded = n === 1 ? AMOUNT : 0;
      expect(
        p.amount_refunded === refunded,
        `${id} amount_refunded ${String(p.amount_refunded)}, expected ${refunded}`,
      );
      expect(p.status === "succeeded", `${id} is ${String(p.status)}`);
    }
    return `${run.chargeIds.length} charges parse as stripe.charge.v2 with the amounts sent`;
  });
  await check("complete enumeration across pages", async () => {
    const q = await reader.query(
      { kind: "stripe.charges.byCustomerInWindow", customerId: run.customerId, ...run.window },
      new Date().toISOString(),
      ctx,
    );
    const want = [...run.chargeIds].sort();
    expect(q.complete, "the query didn't reach the last page");
    expect(
      JSON.stringify(q.matchingIds) === JSON.stringify(want),
      `matched ${q.matchingIds.join(", ")}, expected ${want.join(", ")}`,
    );
    return `${want.length} charges over ${want.length} pages of 1, complete`;
  });
  return checks;
}

/** Differences from the simulator that a native run can show. Listed in every report. */
export const FIDELITY_LIMITS = [
  "Test mode only: no live key, no real funds, and no operational world.",
  "Stripe only. Zendesk and Slack stay simulator-only.",
  "Reads and three creates per run. Faults, 429s and lost responses are not exercised.",
  "Without STRIPE_SANDBOX_API_VERSION the account's default API version decides the charge shape.",
  "Refunds can't be undone: a run's records stay, labelled by run ID.",
];
