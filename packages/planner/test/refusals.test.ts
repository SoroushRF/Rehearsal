import type Anthropic from "@anthropic-ai/sdk";
import { PlanManifest } from "@rehearsal/contracts";
import { evaluateBillingPolicy, noteBodyFor, replyBodyFor, validateGraph } from "@rehearsal/core";
import { STRIPE_CHARGE_PROJECTION, ZENDESK_TICKET_PROJECTION } from "@rehearsal/providers";
import { INCIDENT, incidentRecords } from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import {
  type MessagesClient,
  type PlanningSession,
  REFUND_INSTEAD,
  REFUSAL_REASONS,
  runPlanningLoop,
  SYSTEM_PROMPT,
} from "../src";
import { POLICY_V2, world } from "./world";

/**
 * T1.39: refusals carry a typed reason, and only a refusal of the credit itself sends the model to
 * a refund. Credit steps get their own note and reply.
 */
const META = {
  orgId: "org_demo",
  incidentId: INCIDENT.incident,
  planId: "plan_refusals",
  model: "test",
  promptVersion: "test",
  adapters: { stripe: STRIPE_CHARGE_PROJECTION, zendesk: ZENDESK_TICKET_PROJECTION },
};
const caseOf = (key: string) => {
  const c = incidentRecords().cases.find((x) => x.key === key);
  if (!c) throw new Error(key);
  return c;
};
const pair = (key: string) => {
  const c = caseOf(key);
  return { chargeId: c.chargeIds[1], duplicateOfChargeId: c.chargeIds[0], rationale: "x" };
};
const credit = (s: PlanningSession, key: string) => s.call("propose_balance_credit", pair(key));
const refund = (s: PlanningSession, key: string) => s.call("propose_duplicate_refund", pair(key));
const credits = () => world({ credits: true, policy: POLICY_V2 });

describe("typed refusals (T1.39)", () => {
  it("lets a refund follow only a refusal of the credit itself", async () => {
    // credit_limit: c02's duplicate is over the credit limit. A refund settles it.
    const big = credits();
    expect(await credit(big.session, "c02")).toMatchObject({ ok: false, reason: "credit_limit" });
    expect((await refund(big.session, "c02")).ok).toBe(true);

    // customer_currency: the balance is kept in USD, but the card is refunded in the charge's CAD.
    const usd = credits();
    usd.customerCurrencies.set(caseOf("c01").customerId, "usd");
    expect(await credit(usd.session, "c01")).toMatchObject({
      ok: false,
      reason: "customer_currency",
    });
    expect((await refund(usd.session, "c01")).ok).toBe(true);

    // credits_off / no_credit_policy: the mechanism is unavailable, not the remedy.
    const off = world({ policy: POLICY_V2 });
    expect(await credit(off.session, "c01")).toMatchObject({ reason: "credits_off" });
    expect((await refund(off.session, "c01")).ok).toBe(true);
    const v1 = world({ credits: true });
    expect(await credit(v1.session, "c01")).toMatchObject({ reason: "no_credit_policy" });
    expect((await refund(v1.session, "c01")).ok).toBe(true);

    for (const r of ["credit_limit", "customer_currency", "credits_off", "no_credit_policy"]) {
      expect(REFUND_INSTEAD.has(r as never)).toBe(true);
    }
  });

  it("refuses the refund too, with the same reason, when the credit was refused for the duplicate", async () => {
    // Already settled by a credit: a refund would be a second remedy.
    const settled = credits();
    expect((await credit(settled.session, "c01")).ok).toBe(true);
    expect(await credit(settled.session, "c01")).toMatchObject({ reason: "already_remedied" });
    expect(await refund(settled.session, "c01")).toMatchObject({ reason: "already_remedied" });

    // Refunded in the meantime.
    const refunded = credits();
    const dup = refunded.charges.get(caseOf("c01").chargeIds[1]) as Record<string, unknown>;
    dup.amount_refunded = dup.amount;
    expect(await credit(refunded.session, "c01")).toMatchObject({ reason: "already_refunded" });
    expect(await refund(refunded.session, "c01")).toMatchObject({ reason: "already_refunded" });

    // Another currency than the policy's: left for a human either way.
    const control = incidentRecords().cases.find(
      (c) => c.kind !== "duplicate" && c.currency !== "cad",
    );
    if (control) {
      const other = credits();
      const input = {
        chargeId: control.chargeIds[1],
        duplicateOfChargeId: control.chargeIds[0],
        rationale: "x",
      };
      const c = await other.session.call("propose_balance_credit", input);
      const r = await other.session.call("propose_duplicate_refund", input);
      expect(c.ok).toBe(false);
      expect(r).toMatchObject({ ok: false, reason: c.ok ? undefined : c.reason });
      if (!c.ok) expect(REFUND_INSTEAD.has(c.reason)).toBe(false);
    }
  });

  it("gives every refusal a known reason", async () => {
    const { session } = credits();
    const results = [
      await session.call("no_such_tool", {}),
      await session.call("get_charge", { chargeId: "not-a-charge" }),
      await session.call("get_charge", { chargeId: "ch_missing" }),
      await session.call("propose_refund_note", { refundStepId: "refund_x", ticketId: "1" }),
      await session.call("propose_run_summary", {}),
    ];
    expect(results.map((r) => (r.ok ? "ok" : r.reason))).toEqual([
      "unknown_tool",
      "invalid_input",
      "read_failed",
      "not_a_remedy",
      "no_summary_channel",
    ]);
    for (const r of results) if (!r.ok) expect(REFUSAL_REASONS).toContain(r.reason);
  });
});

describe("credit follow-ups (T1.39)", () => {
  it("notes, raises and replies after a credit, each waiting for it", async () => {
    const c = caseOf("c01");
    const { session } = world({
      credits: true,
      policy: POLICY_V2,
      customerNames: { [c.customerId]: c.name },
    });
    expect((await credit(session, "c01")).ok).toBe(true);
    const creditId = `credit_${c.chargeIds[1]}`;
    const ticketId = String(c.ticketId);
    for (const [name, input] of [
      [
        "propose_ticket_priority",
        { customerId: c.customerId, ticketId, priority: "high", rationale: "x" },
      ],
      ["propose_refund_note", { refundStepId: creditId, ticketId }],
      ["propose_customer_reply", { refundStepId: creditId, ticketId }],
    ] as const) {
      const r = await session.call(name, input);
      if (!r.ok) throw new Error(`${name}: ${r.error}`);
    }
    const manifest = PlanManifest.parse(session.manifest(META));
    const note = manifest.actions.find((a) => a.id === `note_${creditId}`);
    const reply = manifest.actions.find((a) => a.id === `reply_${creditId}`);
    expect(note).toMatchObject({
      kind: "zendesk.ticket.appendPrivateNote",
      dependsOn: [creditId],
      args: {
        template: { id: "credit-applied", version: 1 },
        bindings: { amountMinor: c.amountMinor },
      },
    });
    expect(reply).toMatchObject({
      kind: "zendesk.ticket.appendPublicReply",
      dependsOn: [creditId],
      args: { template: { id: "credit-applied", version: 1 } },
    });
    if (note?.kind !== "zendesk.ticket.appendPrivateNote") throw new Error("no note");
    if (reply?.kind !== "zendesk.ticket.appendPublicReply") throw new Error("no reply");
    const amount = `${(c.amountMinor / 100).toFixed(2)} CAD`;
    expect(noteBodyFor(note, new Map(), "op_test")).toContain(`A balance credit of ${amount}`);
    expect(replyBodyFor(reply)).toBe(
      `Hi ${c.name},\n\nWe've added a credit of ${amount} to your account balance for the duplicate charge. Sorry for the trouble.`,
    );
    expect(validateGraph(manifest.actions)).toEqual([]);
    expect(evaluateBillingPolicy(manifest, POLICY_V2).violations).toEqual([]);
  });
});

describe("what the model hears back (T1.39)", () => {
  it("sends the reason, and refundInstead only when a refund is the right next step", async () => {
    const { session } = credits();
    const seen: unknown[] = [];
    const turns = [
      [
        ["list_customer_charges", { customerId: caseOf("c02").customerId }],
        ["propose_balance_credit", pair("c02")],
        ["propose_duplicate_refund", pair("c02")],
        ["propose_balance_credit", pair("c02")],
      ],
      [],
    ];
    const client: MessagesClient = {
      async create(req) {
        seen.push(req.messages.at(-1)?.content);
        const calls = turns.shift() ?? [];
        return {
          id: "m",
          type: "message",
          role: "assistant",
          model: "test",
          content:
            calls.length === 0
              ? [{ type: "text", text: "done" }]
              : calls.map(([name, input], i) => ({ type: "tool_use", id: `t${i}`, name, input })),
          stop_reason: calls.length > 0 ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        } as unknown as Anthropic.Message;
      },
    };
    const c02 = caseOf("c02");
    await runPlanningLoop({
      client,
      model: "test",
      session,
      brief: {
        incident: INCIDENT.incident,
        summary: "x",
        window: INCIDENT.window,
        customers: [
          { customerId: c02.customerId, name: c02.name, requesterId: String(c02.requesterId) },
        ],
      },
      meta: { orgId: "org_demo", planId: "plan_feedback", adapters: META.adapters },
    });
    const results = (seen[1] as { content: string }[]).map((r) => JSON.parse(r.content));
    expect(results[1]).toMatchObject({ reason: "credit_limit", refundInstead: true });
    expect(results[2]).toMatchObject({ actionId: `refund_${c02.chargeIds[1]}` });
    expect(results[3]).toMatchObject({ reason: "already_remedied" });
    expect(results[3]).not.toHaveProperty("refundInstead");
    expect(SYSTEM_PROMPT).toContain('"refundInstead": true');
  });
});
