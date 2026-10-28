import {
  createReadGuard,
  evaluateBillingPolicy,
  excludeActions,
  executeRehearsal,
  planHash,
  validateGraph,
} from "@rehearsal/core";
import {
  FakeClock,
  INCIDENT,
  incidentRecords,
  MemoryApplyStore,
  MemoryJournal,
  worldFromManifest,
} from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import type { PlanningSession, ToolResult } from "../src";
import { POLICY_V2, world } from "./world";

const c = incidentRecords().cases.find((x) => x.key === "c01");
const large = incidentRecords().cases.find((x) => x.key === "c02");
if (!c || !large) throw new Error("missing cases");
const pair = (x = c) => ({
  chargeId: x.chargeIds[1],
  duplicateOfChargeId: x.chargeIds[0],
  rationale: "Duplicate invoice charge.",
});
const meta = {
  orgId: "org_demo",
  incidentId: INCIDENT.incident,
  planId: "plan_credit_followup",
  model: "fixture",
  promptVersion: "fixture",
  adapters: {},
};
const ok = async (session: PlanningSession, name: string, input: unknown) => {
  const result = await session.call(name, input);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result;
};

describe("typed credit refusal and follow-ups (#285)", () => {
  it("permits refund fallback only when a valid credit exceeds its limit", async () => {
    const { session } = world({ credits: true, policy: POLICY_V2 });
    expect(await session.call("propose_balance_credit", pair(large))).toMatchObject({
      ok: false,
      reason: "credit_limit",
    });
    await ok(session, "propose_duplicate_refund", pair(large));
    expect(session.actions[0]?.kind).toBe("stripe.refund.create");
  });

  it("does not disguise a currency refusal as a limit refusal or allow its refund fallback", async () => {
    const { session, customerCurrencies } = world({ credits: true, policy: POLICY_V2 });
    customerCurrencies.set(large.customerId, "usd");
    expect(await session.call("propose_balance_credit", pair(large))).toMatchObject({
      ok: false,
      reason: "currency_mismatch",
    });
    expect(await session.call("propose_duplicate_refund", pair(large))).toMatchObject({
      ok: false,
      reason: "refund_fallback_forbidden",
    });
    expect(session.actions).toEqual([]);
  });

  it("refuses fallback after an already-settled charge or failed read", async () => {
    for (const scenario of ["settled", "read_failed"] as const) {
      const { session, charges } = world({ credits: true, policy: POLICY_V2 });
      const original = charges.get(c.chargeIds[1]);
      if (!original) throw new Error("missing charge");
      if (scenario === "settled") original.amount_refunded = c.amountMinor;
      else charges.delete(c.chargeIds[1]);
      expect(await session.call("propose_balance_credit", pair())).toMatchObject({
        ok: false,
        reason: scenario === "settled" ? "already_remedied" : "read_failed",
      });
      charges.set(c.chargeIds[1], { ...original, amount_refunded: 0 });
      expect(await session.call("propose_duplicate_refund", pair())).toMatchObject({
        ok: false,
        reason: "refund_fallback_forbidden",
      });
      expect(session.actions).toEqual([]);
    }
  });

  it("returns typed reasons for unknown tools, invalid input and ordinary preconditions", async () => {
    const { session } = world();
    const results: ToolResult[] = [
      await session.call("http_get", {}),
      await session.call("get_charge", { chargeId: "bad" }),
      await session.call("propose_refund_note", {
        refundStepId: "missing",
        ticketId: String(c.ticketId),
      }),
    ];
    expect(results.map((r) => !r.ok && r.reason)).toEqual([
      "unknown_tool",
      "invalid_input",
      "precondition_failed",
    ]);
  });

  it("renders and executes credit-specific notes/replies and separate summary counts", async () => {
    const { session } = world({
      credits: true,
      policy: POLICY_V2,
      customerNames: { [c.customerId]: "Alex" },
      runSummary: { channelId: "C_DEMO", incidentId: INCIDENT.incident },
    });
    await ok(session, "propose_balance_credit", pair());
    const creditId = session.actions[0]?.id;
    const input = { creditStepId: creditId, ticketId: String(c.ticketId) };
    await ok(session, "propose_credit_note", input);
    await ok(session, "propose_credit_reply", input);
    // Refund tools cannot describe a credit using refund wording.
    expect(
      await session.call("propose_refund_note", {
        refundStepId: creditId,
        ticketId: String(c.ticketId),
      }),
    ).toMatchObject({ ok: false });
    await ok(session, "propose_run_summary", {});
    const manifest = session.manifest(meta);
    expect(validateGraph(manifest.actions)).toEqual([]);
    expect(evaluateBillingPolicy(manifest, POLICY_V2).violations).toEqual([]);
    expect(
      excludeActions(manifest, [String(creditId)]).actions.every(
        (a) => a.kind === "slack.message.postSummary",
      ),
    ).toBe(true);
    const store = new MemoryApplyStore();
    const hash = planHash(manifest);
    store.plans.set(`${manifest.planId}@1`, { planHash: hash, manifest });
    const fake = worldFromManifest(manifest.observations);
    const clock = new FakeClock("2026-10-02T12:00:00.000Z");
    const providers = {
      stripe: fake.provider("stripe"),
      zendesk: fake.provider("zendesk"),
      slack: fake.provider("slack"),
    };
    // FakeWorld retains the same projected fields but uses legacy v1 projection names.
    // Adapt its reads to the planner's recorded versions without changing any read values.
    for (const vendor of ["stripe", "zendesk"] as const) {
      const base = providers[vendor];
      providers[vendor] = {
        ...base,
        observe: async (entity, ctx) => {
          const read = await base.observe(entity, ctx);
          return {
            ...read,
            projectionVersion:
              manifest.observations.find(
                (o) => o.entity.vendor === vendor && o.entity.kind === entity.kind,
              )?.projectionVersion ?? read.projectionVersion,
          };
        },
        query: async (...args) => {
          const read = await base.query(...args);
          return {
            ...read,
            projectionVersion:
              manifest.queryObservations.find((q) => q.vendor === vendor)?.projectionVersion ??
              read.projectionVersion,
          };
        },
      };
    }
    const worlds = {
      stripe: { world: "rehearsal" as const, tenant: "rh-credit285" },
      zendesk: { world: "rehearsal" as const, tenant: "rh-credit285" },
      slack: { world: "rehearsal" as const, tenant: "rh-credit285" },
    };
    let seq = 0;
    const result = await executeRehearsal(
      {
        orgId: manifest.orgId,
        rehearsalId: "credit285",
        planId: manifest.planId,
        revision: 1,
        planHash: hash,
      },
      {
        plans: {
          loadPlan: (...args) => store.loadPlan(...args),
          rehearsalCancelled: async () => false,
        },
        journal: new MemoryJournal(),
        clock,
        providers,
        worlds,
        policies: [POLICY_V2],
        guard: createReadGuard({ providers, worlds, clock }),
        newId: (p) => `${p}_${++seq}`,
        sleep: async () => {},
      },
    );
    expect(
      result.receipts.map((r) => r.outcome),
      JSON.stringify(result.receipts),
    ).toEqual(["confirmed", "confirmed", "confirmed", "confirmed"]);
    expect(fake.credits).toHaveLength(1);
    expect(fake.refunds).toHaveLength(0);
    const comments = fake.tickets.get(String(c.ticketId))?.comments;
    expect(comments).toHaveLength(2);
    expect(comments?.every((x) => x.body.includes("credit") && !x.body.includes("refunded"))).toBe(
      true,
    );
    expect(fake.messages[0]?.text).toContain("0 refund(s) issued, 1 balance credit(s) issued");
  });

  it("refuses credit follow-ups for another customer's ticket or without a credit", async () => {
    const { session } = world({
      credits: true,
      policy: POLICY_V2,
      customerNames: { [c.customerId]: "Alex" },
    });
    await ok(session, "propose_balance_credit", pair());
    for (const tool of ["propose_credit_note", "propose_credit_reply"]) {
      expect(
        await session.call(tool, {
          creditStepId: session.actions[0]?.id,
          ticketId: String(large.ticketId),
        }),
      ).toMatchObject({ ok: false });
      expect(
        await session.call(tool, { creditStepId: "missing", ticketId: String(c.ticketId) }),
      ).toMatchObject({ ok: false });
    }
    expect(session.actions).toHaveLength(1);
  });

  it("keeps credit and refund summary counts separate in a mixed plan", async () => {
    const { session } = world({
      credits: true,
      policy: POLICY_V2,
      runSummary: { channelId: "C_DEMO", incidentId: INCIDENT.incident },
    });
    await ok(session, "propose_balance_credit", pair());
    await ok(session, "propose_duplicate_refund", pair(large));
    await ok(session, "propose_run_summary", {});
    const summary = session.actions.at(-1);
    expect(summary?.args).toMatchObject({
      template: { id: "run-summary", version: 2 },
      bindings: {
        credited: { stepIds: [`credit_${c.chargeIds[1]}`] },
        refunded: { stepIds: [`refund_${large.chargeIds[1]}`] },
      },
    });
    expect(validateGraph(session.actions)).toEqual([]);
  });
});
