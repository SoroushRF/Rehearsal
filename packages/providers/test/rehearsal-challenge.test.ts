import { happyPathBundle } from "@rehearsal/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyRehearsalChallenges } from "../../../scripts/inject/challenge";

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
    REHEARSAL_ERA_ADMIN_TOKEN: "rehearsal-admin",
    ERA_ADMIN_TOKEN: "shared-admin",
    ...overrides,
  };
}

describe("rehearsal challenge operator (T4.11)", () => {
  const calls: { url: string; init?: RequestInit }[] = [];

  afterEach(() => {
    calls.length = 0;
    vi.unstubAllGlobals();
  });

  function stubFetch() {
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/token")) {
        return Promise.resolve(Response.json({ access_token: "signed-tenant", expires_in: 3600 }));
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
  }

  it("injects the phantom and its control into that rehearsal's stripe tenant only", async () => {
    stubFetch();
    const result = await applyRehearsalChallenges({
      rehearsalId,
      manifest,
      scenario: { id: "phantom_membership", version: 1 },
      phase: "before_run",
      env: env(),
    });
    expect(result.applied).toHaveLength(1);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("no inject");
    expect(call.url).toBe("http://127.0.0.1:8103/_admin/tenants/rh-abcd1234/inject");
    expect(call.init?.method).toBe("POST");
    const headers = new Headers(call.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer rehearsal-admin");
    const body = JSON.parse(String(call.init?.body)) as {
      charges: Array<{ id: string; customer: string; created: number }>;
    };
    expect(body.charges.map((c) => c.customer)).toEqual(["cus_fixture_001", "cus_fixture_001"]);
    expect(body.charges.map((c) => c.id)).not.toContain("ch_7wD2ja8lIorW65Uh");
    expect(body.charges.every((c) => c.id.startsWith("ch_rh"))).toBe(true);
    const start = Date.parse("2026-09-01T00:00:00.000Z") / 1000;
    const end = Date.parse("2026-10-01T00:00:00.000Z") / 1000;
    expect(body.charges[0]?.created).toBeGreaterThanOrEqual(start);
    expect(body.charges[0]?.created).toBeLessThan(end);
    expect(body.charges[1]?.created).toBeGreaterThanOrEqual(end);
    expect(calls.some((c) => /reset|faults/.test(c.url))).toBe(false);
  });

  it("refuses a rehearsal URL that is a shared world, and sends nothing", async () => {
    stubFetch();
    await expect(
      applyRehearsalChallenges({
        rehearsalId,
        manifest,
        scenario: { id: "phantom_membership", version: 1 },
        phase: "before_run",
        env: env({
          ERA_STRIPE_REHEARSAL_URL: "http://localhost:8101",
          ERA_STRIPE_PLANNING_URL: "http://127.0.0.1:8101",
        }),
      }),
    ).rejects.toThrow(/shared world/);
    expect(calls).toEqual([]);
  });

  it("leaves a lost response and a teammate edit for the runner instead of touching a world", async () => {
    stubFetch();
    const shared = env({
      ERA_STRIPE_REHEARSAL_URL: "http://127.0.0.1:8101",
      ERA_STRIPE_PLANNING_URL: "http://127.0.0.1:8101",
    });
    const lost = await applyRehearsalChallenges({
      rehearsalId,
      manifest,
      scenario: { id: "lost_response_restart", version: 1 },
      phase: "before_run",
      env: shared,
    });
    expect(lost.applied).toEqual([]);
    expect(lost.waiting).toEqual(["drop_response_after_commit refund_001 then restart"]);
    const teammate = await applyRehearsalChallenges({
      rehearsalId,
      manifest,
      scenario: { id: "teammate_field_edit", version: 1 },
      phase: "before_run",
      env: env(),
    });
    expect(teammate.applied).toEqual([]);
    expect(teammate.waiting.join("\n")).toMatch(/fail_step note_001/);
    expect(teammate.waiting.join("\n")).toMatch(
      /until note_001 is rejected, before compensation reads the ticket/,
    );
    expect(calls).toEqual([]);
  });

  it("writes the teammate priority only after the named note was rejected", async () => {
    stubFetch();
    const result = await applyRehearsalChallenges({
      rehearsalId,
      manifest,
      scenario: { id: "teammate_field_edit", version: 1 },
      phase: "after_rejected",
      actionId: "note_001",
      env: env(),
    });
    expect(result.applied).toEqual(["priority urgent on /api/v2/tickets/5531.json"]);
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:8113/token",
      "http://127.0.0.1:8113/api/v2/tickets/5531.json",
    ]);
    const tokenCall = calls[0];
    const write = calls[1];
    if (!tokenCall || !write) throw new Error("missing calls");
    expect(new Headers(tokenCall.init?.headers).get("x-sim-admin-token")).toBe("rehearsal-admin");
    const headers = new Headers(write.init?.headers);
    expect(headers.get("x-sim-tenant")).toBe("signed-tenant");
    expect(write.init?.method).toBe("PUT");
    expect(JSON.parse(String(write.init?.body))).toEqual({ ticket: { priority: "urgent" } });
    expect(calls.some((c) => /8101|8102|8111|8112|reset|faults/.test(c.url))).toBe(false);
  });
});
