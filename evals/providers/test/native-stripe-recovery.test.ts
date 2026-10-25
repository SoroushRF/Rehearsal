import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { PlanManifest } from "@rehearsal/contracts";
import {
  type BillingPolicy,
  executeRehearsal,
  type ProviderPort,
  planHash,
  type RehearsalExecutorDeps,
  rehearsalTenant,
} from "@rehearsal/core";
import { stripeWriter, type WriteTarget } from "@rehearsal/providers";
import { FakeClock, happyPathBundle, MemoryJournal, worldFromManifest } from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import policy from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import policyV3 from "../../../scenarios/billing/policy.v3.json" with { type: "json" };
import {
  STRIPE_API,
  sandboxClient,
  sandboxKey,
  seedSandbox,
} from "../../../scripts/stripe-sandbox/sandbox";

/**
 * T3.18: the executor's recovery discipline against native Stripe test mode. One exact-hash
 * refund, its note depending on it, run through the shared mechanics (T3.14) and journal; then the
 * same with the refund's response dropped after Stripe committed it, and a restart. The native
 * sandbox is never an operational world (decision 0013, §7), so this runs under rehearsal
 * admission, which re-checks the stored plan's exact hash; the mechanics are the operational ones.
 *
 * Two modes: always against an in-memory Stripe stand-in (`fixture`); and, opt-in with
 * STRIPE_SANDBOX=1 and an sk_test_ key in .env.stripe-sandbox, against the real test-mode account
 * (`native_stripe_test`), which also writes redacted evidence to docs/evidence/.
 */

const POLICIES = [policy, policyV3] as unknown as BillingPolicy[];
const AMOUNT = 4210;

/** A minimal Stripe test-mode stand-in: account, refunds with idempotency, refund listing. */
function fakeStripe(account: string, opts: { refundStatus?: string } = {}) {
  const refunds: Record<string, unknown>[] = [];
  const keys = new Map<string, { body: string; response: string }>();
  let n = 0;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    if (!headers.get("authorization")?.startsWith("Bearer sk_test_"))
      return json(401, { error: { message: "no key" } });
    if (url.pathname === "/v1/account")
      return json(200, { id: account, object: "account", livemode: false });
    if (url.pathname === "/v1/refunds" && init.method === "POST") {
      const body = String(init.body ?? "");
      const key = headers.get("idempotency-key") ?? "";
      const seen = keys.get(key);
      if (seen) {
        return seen.body === body
          ? new Response(seen.response, { status: 200, headers: { "idempotent-replayed": "true" } })
          : json(400, { error: { type: "idempotency_error" } });
      }
      const form = new URLSearchParams(body);
      const refund = {
        id: `re_fake${++n}`,
        object: "refund",
        amount: Number(form.get("amount")),
        charge: form.get("charge"),
        currency: "cad",
        status: opts.refundStatus ?? "succeeded",
        metadata: { rehearsal_op: form.get("metadata[rehearsal_op]") },
        livemode: false,
      };
      refunds.push(refund);
      const response = JSON.stringify(refund);
      keys.set(key, { body, response });
      return new Response(response, { status: 200 });
    }
    if (url.pathname === "/v1/refunds") {
      const charge = url.searchParams.get("charge");
      return json(200, {
        object: "list",
        livemode: false,
        has_more: false,
        data: refunds.filter((r) => r.charge === charge),
      });
    }
    return json(404, { error: { message: `no route ${url.pathname}` } });
  };
  return { fetch: fetchImpl as typeof fetch, refunds };
}

/** The fixture plan's case_001 (refund, patch, note), its refund aimed at `chargeId`. */
function manifestFor(chargeId: string): PlanManifest {
  const { manifest } = happyPathBundle();
  const actions = manifest.actions
    .filter((a) => a.caseId === "case_001")
    .map((a) => {
      const copy = structuredClone(a);
      if (copy.kind === "stripe.refund.create") {
        copy.args.chargeId = chargeId;
        copy.args.amount = { amountMinor: AMOUNT, currency: "cad" };
      }
      if (copy.kind === "zendesk.ticket.appendPrivateNote") {
        copy.args.bindings = { ...copy.args.bindings, amountMinor: AMOUNT };
      }
      return copy;
    });
  const observations = manifest.observations.map((o) =>
    o.entity.kind === "charge" && o.id === "obs_charge_001"
      ? {
          ...o,
          entity: { ...o.entity, id: chargeId },
          projection: { ...o.projection, id: chargeId, amount: AMOUNT },
        }
      : o,
  );
  return { ...manifest, actions, observations };
}

interface Mode {
  name: "fixture" | "native_stripe_test";
  target: (tenant: string) => WriteTarget;
  chargeId: () => Promise<string>;
  refundsOf: (chargeId: string) => Promise<Record<string, unknown>[]>;
}

/** Run case_001 once (or again, for a restart) through the shared mechanics. */
function rehearsalOf(
  mode: Mode,
  manifest: PlanManifest,
  rehearsalId: string,
  journal = new MemoryJournal(),
) {
  const hash = planHash(manifest);
  const tenant = rehearsalTenant(rehearsalId);
  const zendesk = worldFromManifest(manifest.observations).provider("zendesk");
  let stripe: ProviderPort = {
    ...stripeWriter(mode.target(tenant)),
    observe: async () => {
      throw new Error("no reads");
    },
    query: async () => {
      throw new Error("no reads");
    },
  };
  const deps: RehearsalExecutorDeps = {
    plans: { loadPlan: async () => ({ planHash: hash, manifest }) },
    journal,
    providers: { stripe, zendesk },
    worlds: { stripe: { world: "rehearsal", tenant }, zendesk: { world: "rehearsal", tenant } },
    clock: new FakeClock(new Date().toISOString()),
    policies: POLICIES,
    newId: (p) => `${p}_${Math.random().toString(36).slice(2)}`,
    sleep: async () => {},
    reconcileAfterMs: 0,
  };
  const run = () =>
    executeRehearsal(
      {
        orgId: manifest.orgId,
        rehearsalId,
        planId: manifest.planId,
        revision: manifest.revision,
        planHash: hash,
      },
      deps,
    );
  const loseNextRefundResponse = () => {
    const real = stripe;
    let lost = false;
    stripe = {
      ...real,
      dispatch: async (req, ctx) => {
        const res = await real.dispatch(req, ctx); // Stripe commits it...
        if (lost || req.path !== "/v1/refunds") return res;
        lost = true;
        return { kind: "unknown", error: "response dropped after commit (test transport)" }; // ...we never hear back
      },
    };
    deps.providers.stripe = stripe;
    deps.retry = { maxAttempts: 1 };
  };
  const restore = () => {
    deps.providers.stripe = {
      ...stripeWriter(mode.target(tenant)),
      observe: stripe.observe,
      query: stripe.query,
    };
    deps.retry = undefined;
  };
  return { deps, journal, run, loseNextRefundResponse, restore, hash };
}

const outcomes = (receipts: { actionId: string; outcome: string }[]) =>
  Object.fromEntries(receipts.map((r) => [r.actionId, r.outcome]));

function recoveryGate(mode: Mode) {
  it("confirms an exact-hash refund only once Stripe's own read shows it, then sends its note", {
    timeout: 90_000,
  }, async () => {
    const chargeId = await mode.chargeId();
    const r = rehearsalOf(mode, manifestFor(chargeId), `t318a${Date.now().toString(36)}`);
    const result = await r.run();
    expect(outcomes(result.receipts)).toMatchObject({
      refund_001: "confirmed",
      note_001: "confirmed",
    });
    expect(result.receipts.find((x) => x.actionId === "refund_001")?.limitations).toContain(
      "read back from the provider after the write",
    );
    expect(await mode.refundsOf(chargeId)).toHaveLength(1);
  });

  it("recovers a refund whose response was lost after commit: one refund, correlated by its key", {
    timeout: 90_000,
  }, async () => {
    const chargeId = await mode.chargeId();
    const id = `t318b${Date.now().toString(36)}`;
    const r = rehearsalOf(mode, manifestFor(chargeId), id);
    r.loseNextRefundResponse();
    const first = await r.run();
    // Unknown, so the note announcing the refund is withheld.
    expect(outcomes(first.receipts)).toMatchObject({
      refund_001: "unknown_outcome",
      note_001: "skipped_dependency",
    });

    // Restart: the same journal, a fresh pass. Stripe is read, never re-sent blindly.
    r.restore();
    const second = await r.run();
    expect(outcomes(second.receipts)).toMatchObject({
      refund_001: "confirmed",
      note_001: "confirmed",
    });
    const refunds = await mode.refundsOf(chargeId);
    expect(refunds).toHaveLength(1);
    const attempts = [...r.journal.attempts.values()].filter((a) => a.actionId === "refund_001");
    // The one refund carries the journaled operation key; every attempt sent the same bytes.
    expect((refunds[0]?.metadata as { rehearsal_op?: string } | undefined)?.rehearsal_op).toBe(
      attempts[0]?.operationKey,
    );
    expect(new Set(attempts.map((a) => a.request.body)).size).toBe(1);
    if (mode.name === "native_stripe_test") writeEvidence(id, chargeId, refunds, attempts.length);
  });
}

describe("native Stripe recovery gate, against a Stripe stand-in (T3.18, fixture)", () => {
  const account = "acct_fixture";
  let fake = fakeStripe(account);
  let charge = 0;
  const mode: Mode = {
    name: "fixture",
    target: (tenant) => ({
      world: "rehearsal",
      config: { baseUrl: "https://stripe.fixture", tenant },
      authorization: "Bearer sk_test_fixture",
      transport: "native",
      accountId: account,
      fetch: fake.fetch,
    }),
    chargeId: async () => `ch_fixture_t318_${++charge}`,
    refundsOf: async (c) => fake.refunds.filter((r) => r.charge === c),
  };
  recoveryGate(mode);

  it.each(["pending", "failed"])("holds a %s refund and withholds its note", async (status) => {
    fake = fakeStripe(account, { refundStatus: status });
    const r = rehearsalOf(mode, manifestFor(await mode.chargeId()), `t318c${status}`);
    const result = await r.run();
    expect(outcomes(result.receipts).refund_001).not.toBe("confirmed");
    expect(outcomes(result.receipts).note_001).toBe("skipped_dependency");
    fake = fakeStripe(account);
  });
});

/** A pinned Stripe-Version, when the sandbox env names one. */
const versionHeader = (): Record<string, string> => {
  const v = process.env.STRIPE_SANDBOX_API_VERSION;
  return v ? { "stripe-version": v } : {};
};

const SANDBOX_FILE = new URL("../../../.env.stripe-sandbox", import.meta.url);
const NATIVE = process.env.STRIPE_SANDBOX === "1" && existsSync(SANDBOX_FILE);

describe.skipIf(!NATIVE)("native Stripe recovery gate, against real test mode (T3.18)", () => {
  if (NATIVE) process.loadEnvFile(SANDBOX_FILE);
  let run: Awaited<ReturnType<typeof seedSandbox>> | undefined;
  const client = NATIVE ? sandboxClient() : undefined;
  let used = 0;
  const mode: Mode = {
    name: "native_stripe_test",
    target: (tenant) => ({
      world: "rehearsal",
      config: { baseUrl: STRIPE_API, tenant },
      authorization: `Bearer ${sandboxKey()}`,
      transport: "native",
      accountId: run?.accountId,
      headers: versionHeader(),
      timeoutMs: 20_000,
    }),
    // seedSandbox refunds its second charge; the first and third are free for this gate.
    chargeId: async () => {
      run ??= await seedSandbox(
        client as ReturnType<typeof sandboxClient>,
        `t318${Date.now().toString(36)}`,
      );
      const free = [run.chargeIds[0], run.chargeIds[2]][used++];
      if (!free) throw new Error("no free sandbox charge left");
      return free;
    },
    refundsOf: async (c) =>
      (await (client as ReturnType<typeof sandboxClient>).get(`/v1/refunds?charge=${c}&limit=100`))
        .data as Record<string, unknown>[],
  };
  recoveryGate(mode);
});

/** Redacted evidence of the native run: ids are shortened, the key never appears. */
function writeEvidence(
  rehearsalId: string,
  chargeId: string,
  refunds: Record<string, unknown>[],
  attempts: number,
) {
  const redact = (id: unknown) =>
    typeof id === "string" ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
  const commit = (() => {
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch {
      return "unknown";
    }
  })();
  const dir = new URL("../../../docs/evidence/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    new URL("native-stripe-recovery.json", dir),
    `${JSON.stringify(
      {
        task: "T3.18",
        evidence: "native_stripe_test",
        commit,
        apiVersion: process.env.STRIPE_SANDBOX_API_VERSION ?? "account default",
        ranAt: new Date().toISOString(),
        rehearsalId,
        charge: redact(chargeId),
        refunds: refunds.map((r) => ({
          id: redact(r.id),
          status: r.status,
          amount: r.amount,
          currency: r.currency,
        })),
        attemptsJournaled: attempts,
        limits: [
          "test mode only; no live account or real money",
          "the response loss is injected by the test transport after Stripe committed the refund",
          "runs through rehearsal admission: the native sandbox is never an operational world (decision 0013, §7)",
          "Zendesk is the in-memory stand-in; only Stripe is native",
        ],
      },
      null,
      2,
    )}\n`,
  );
}
