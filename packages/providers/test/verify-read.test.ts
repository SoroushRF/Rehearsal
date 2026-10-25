import type { PlanManifest } from "@rehearsal/contracts";
import { resolveScenario } from "@rehearsal/core";
import { happyPathBundle } from "@rehearsal/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readVerifierEffects } from "../src/verify-read";
import type { WorldConfig } from "../src/worlds";

const manifest = happyPathBundle().manifest;
const rehearsalId = "abcd1234";

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ERA_STRIPE_REHEARSAL_URL: "http://127.0.0.1:8103",
    ERA_STRIPE_PLANNING_URL: "http://127.0.0.1:8101",
    ERA_STRIPE_OPERATIONAL_URL: "http://127.0.0.1:8102",
    ERA_ZENDESK_REHEARSAL_URL: "http://127.0.0.1:8113",
    ERA_ZENDESK_PLANNING_URL: "http://127.0.0.1:8111",
    ERA_ZENDESK_OPERATIONAL_URL: "http://127.0.0.1:8112",
    ...overrides,
  };
}

function worlds(): { stripe: WorldConfig; zendesk: WorldConfig } {
  return {
    stripe: { baseUrl: "http://127.0.0.1:8103", tenant: "rh-abcd1234", tenantToken: "signed" },
    zendesk: { baseUrl: "http://127.0.0.1:8113", tenant: "rh-abcd1234", tenantToken: "signed" },
  };
}

describe("rehearsal verifier reads (T4.12)", () => {
  const calls: { url: string; init?: RequestInit }[] = [];

  afterEach(() => {
    calls.length = 0;
    vi.unstubAllGlobals();
  });

  function stub(handler: (url: string) => Response | Promise<Response>) {
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(handler(String(url)));
    });
  }

  it("lists a finished refund page and does not call a shared world", async () => {
    stub((url) => {
      if (url.includes("/v1/refunds")) {
        return Response.json({
          data: [
            {
              id: "re_1",
              status: "succeeded",
              amount: 4210,
              currency: "cad",
              charge: "ch_fixture_001",
            },
          ],
          has_more: false,
        });
      }
      if (url.includes("/comments.json")) {
        return Response.json({ comments: [], next_page: null });
      }
      if (url.includes("/tickets/")) {
        return Response.json({ ticket: { priority: "high", status: "open" } });
      }
      return new Response("no", { status: 500 });
    });
    const reads = await readVerifierEffects({
      manifest,
      rehearsalId,
      scenario: { id: "clean", version: 1 },
      worlds: worlds(),
      env: env(),
    });
    const refund = reads.refunds.ch_fixture_001;
    expect(refund?.ok).toBe(true);
    if (!refund?.ok) return;
    expect(refund.value.complete).toBe(true);
    expect(refund.value.refunds).toEqual([
      {
        id: "re_1",
        status: "succeeded",
        amountMinor: 4210,
        currency: "cad",
        chargeId: "ch_fixture_001",
      },
    ]);
    expect(calls.some((call) => call.url.startsWith("http://127.0.0.1:8103/v1/refunds"))).toBe(
      true,
    );
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("x-sim-tenant")).toBe("signed");
  });

  it("reports a failed refund page instead of an empty list", async () => {
    stub((url) =>
      url.includes("/v1/refunds?charge=ch_fixture_001")
        ? new Response("down", { status: 500 })
        : Response.json(
            url.includes("/comments")
              ? { comments: [], next_page: null }
              : url.includes("/tickets/")
                ? { ticket: { priority: "high", status: "open" } }
                : { data: [], has_more: false },
          ),
    );
    const reads = await readVerifierEffects({
      manifest,
      rehearsalId,
      scenario: { id: "clean", version: 1 },
      worlds: worlds(),
      env: env(),
    });
    expect(reads.refunds.ch_fixture_001).toEqual({
      ok: false,
      detail: expect.stringContaining("500"),
    });
  });

  it("refuses a live-mode page and a page that claims more rows than it returned", async () => {
    stub((url) =>
      Response.json(
        url.includes("ch_fixture_001")
          ? { data: [], has_more: false, livemode: true }
          : { data: [], has_more: true },
      ),
    );
    const reads = await readVerifierEffects({
      manifest: refundsOnly(manifest),
      rehearsalId,
      scenario: { id: "clean", version: 1 },
      worlds: worlds(),
      env: env(),
    });
    expect(reads.refunds.ch_fixture_001?.ok).toBe(false);
    if (reads.refunds.ch_fixture_001?.ok === false) {
      expect(reads.refunds.ch_fixture_001.detail).toContain("live mode");
    }
    expect(reads.refunds.ch_fixture_002?.ok).toBe(false);
    if (reads.refunds.ch_fixture_002?.ok === false) {
      expect(reads.refunds.ch_fixture_002.detail).toContain("empty refund page");
    }
  });

  it("does not fetch when the bound URL is a shared world", async () => {
    stub(() => Response.json({ data: [], has_more: false }));
    const reads = await readVerifierEffects({
      manifest,
      rehearsalId,
      scenario: { id: "clean", version: 1 },
      worlds: {
        stripe: { baseUrl: "http://127.0.0.1:8102", tenant: "rh-abcd1234" },
        zendesk: { baseUrl: "http://127.0.0.1:8112", tenant: "rh-abcd1234" },
      },
      env: env(),
    });
    expect(calls).toEqual([]);
    expect(reads.refunds.ch_fixture_001?.ok).toBe(false);
    expect(reads.tickets["5531"]?.ok).toBe(false);
  });

  it("keeps a charge the server returned outside the window", async () => {
    const bound = resolveScenario(manifest, { id: "benign_nonmatching_change", version: 1 });
    if (!bound.ok) throw new Error(bound.reason);
    const control = bound.scenario.effects.find((effect) => effect.kind === "query_membership");
    if (control?.kind !== "query_membership") throw new Error("missing control");
    stub((url) => {
      if (url.includes("/v1/charges?")) {
        return Response.json({
          data: [{ id: control.chargeId, customer: "cus_fixture_001", created: 0 }],
          has_more: false,
        });
      }
      if (url.includes("/v1/refunds")) return Response.json({ data: [], has_more: false });
      if (url.includes("/comments.json")) return Response.json({ comments: [], next_page: null });
      return Response.json({ ticket: { priority: "high", status: "open" } });
    });
    const reads = await readVerifierEffects({
      manifest,
      rehearsalId,
      scenario: { id: "benign_nonmatching_change", version: 1 },
      worlds: worlds(),
      env: env(),
    });
    expect(reads.queries[control.queryId]).toEqual({
      ok: true,
      value: { complete: true, matchingIds: [control.chargeId] },
    });
  });

  it("does not treat a Slack page that says there is more history as the whole channel", async () => {
    stub(() => Response.json({ ok: true, messages: [], has_more: true }));
    const reads = await readVerifierEffects({
      manifest: slackOnly(manifest),
      rehearsalId,
      scenario: { id: "clean", version: 1 },
      worlds: {
        ...worlds(),
        slack: { baseUrl: "http://127.0.0.1:8123", tenant: "rh-abcd1234", tenantToken: "signed" },
      },
      env: env({
        ERA_SLACK_REHEARSAL_URL: "http://127.0.0.1:8123",
        ERA_SLACK_PLANNING_URL: "http://127.0.0.1:8121",
        ERA_SLACK_OPERATIONAL_URL: "http://127.0.0.1:8122",
      }),
    });
    expect(reads.slack.C_BILLING).toEqual({
      ok: false,
      detail: "more Slack history but no cursor",
    });
  });
});

function refundsOnly(source: PlanManifest): PlanManifest {
  return {
    ...source,
    actions: source.actions.filter((action) => action.kind === "stripe.refund.create"),
  };
}

function slackOnly(source: PlanManifest): PlanManifest {
  const refund = source.actions.find((action) => action.kind === "stripe.refund.create");
  if (!refund) throw new Error("no refund");
  return {
    ...source,
    actions: [
      {
        id: "summary_001",
        caseId: refund.caseId,
        obligationId: refund.obligationId,
        dependsOn: [refund.id],
        requiredRole: "support_lead",
        evidence: [],
        queryEvidence: [],
        compensation: "irreversible",
        protection: "no_atomic_guard",
        rationale: "test",
        kind: "slack.message.postSummary",
        args: {
          channelId: "C_BILLING",
          template: { id: "run-summary", version: 1 },
          bindings: {
            incidentId: "INC-BILL-0927",
            refunded: { $count: "outcomes", stepIds: [refund.id], outcomes: ["confirmed"] },
            held: { $count: "outcomes", stepIds: [refund.id], outcomes: ["held"] },
          },
        },
      },
    ],
  };
}
