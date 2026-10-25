import { PlanManifest } from "@rehearsal/contracts";
import {
  evaluateBillingPolicy,
  excludeActions,
  fingerprint,
  guardAction,
  planHash,
  replyBodyFor,
  validateGraph,
} from "@rehearsal/core";
import { STRIPE_CHARGE_PROJECTION, ZENDESK_TICKET_PROJECTION } from "@rehearsal/providers";
import { INCIDENT, incidentRecords } from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import {
  CREDIT_TOOL_SCHEMA_HASH,
  type PlanningReader,
  PlanningSession,
  planningToolDefinitions,
  TOOL_SCHEMA_HASH,
} from "../src";
import { POLICY, POLICY_V2, world } from "./world";

const META = {
  orgId: "org_demo",
  incidentId: INCIDENT.incident,
  planId: "plan_tools",
  model: "test",
  promptVersion: "test",
  adapters: { stripe: STRIPE_CHARGE_PROJECTION, zendesk: ZENDESK_TICKET_PROJECTION },
};

const caseOf = (key: string) => {
  const c = incidentRecords().cases.find((x) => x.key === key);
  if (!c) throw new Error(key);
  return c;
};

async function ok(session: PlanningSession, name: string, input: unknown) {
  const r = await session.call(name, input);
  if (!r.ok) throw new Error(`${name}: ${r.error}`);
  return r.result as Record<string, unknown>;
}

describe("planning tools", () => {
  it("keeps a refund bound to its original unrefunded evidence after a later read", async () => {
    const { session, charges } = world();
    const c = caseOf("c01");
    await ok(session, "propose_duplicate_refund", {
      chargeId: c.chargeIds[1],
      duplicateOfChargeId: c.chargeIds[0],
      rationale: "x",
    });
    const action = session.actions[0];
    if (!action) throw new Error("no action");
    (charges.get(c.chargeIds[0]) as Record<string, unknown>).amount_refunded = c.amountMinor;
    await ok(session, "get_charge", { chargeId: c.chargeIds[0] });
    const manifest = session.manifest(META);
    expect(
      manifest.observations.find((o) => o.id === action.evidence[1])?.projection.amount_refunded,
    ).toBe(0);
    const latest = [...new Map(manifest.observations.map((o) => [o.entity.id, o])).values()];
    expect(
      guardAction({
        action,
        plannedObservations: manifest.observations,
        currentObservations: latest,
        plannedQueries: manifest.queryObservations,
        currentQueries: manifest.queryObservations,
      }),
    ).toMatchObject({ decision: "hold", reason: { kind: "row_changed" } });
  });

  it("keeps query evidence pinned when a later read discovers a phantom", async () => {
    const { session, charges } = world();
    const c = caseOf("c01");
    await ok(session, "propose_duplicate_refund", {
      chargeId: c.chargeIds[1],
      duplicateOfChargeId: c.chargeIds[0],
      rationale: "x",
    });
    const copy = charges.get(c.chargeIds[1]);
    charges.set("ch_review_phantom", { ...copy, id: "ch_review_phantom" });
    await ok(session, "list_customer_charges", { customerId: c.customerId });
    const manifest = session.manifest(META),
      action = manifest.actions[0];
    if (!action) throw new Error("no action");
    expect(manifest.queryObservations).toHaveLength(2);
    expect(manifest.queryObservations[0]?.id).toBe(action.queryEvidence[0]);
    expect(
      guardAction({
        action,
        plannedObservations: manifest.observations,
        currentObservations: manifest.observations,
        plannedQueries: manifest.queryObservations,
        currentQueries: manifest.queryObservations.slice(-1),
      }),
    ).toMatchObject({
      decision: "hold",
      reason: { kind: "query_membership_changed", added: ["ch_review_phantom"] },
    });
  });

  it("does not expose mutable session state through evidence or action getters", async () => {
    const { session } = world();
    const c = caseOf("c01");
    await ok(session, "propose_duplicate_refund", {
      chargeId: c.chargeIds[1],
      duplicateOfChargeId: c.chargeIds[0],
      rationale: "x",
    });
    const before = planHash(session.manifest(META));
    const obs = session.observations[0],
      action = session.actions[0],
      query = session.queryObservations[0];
    if (!obs || action?.kind !== "stripe.refund.create" || !query) throw new Error("missing state");
    obs.projection.amount_refunded = 100;
    action.args.amount.amountMinor = 1;
    query.matchingIds.length = 0;
    expect(planHash(session.manifest(META))).toBe(before);
  });
  it("refuses another customer's ticket and an unknown link for both ticket tools", async () => {
    const { session, tickets } = world();
    const a = caseOf("c01");
    const b = caseOf("c02");
    await ok(session, "propose_duplicate_refund", {
      chargeId: a.chargeIds[1],
      duplicateOfChargeId: a.chargeIds[0],
      rationale: "x",
    });
    for (const ticketId of [b.ticketId, a.ticketId]) {
      if (ticketId === a.ticketId)
        (tickets.get(String(ticketId)) as Record<string, unknown>).external_id = null;
      expect(
        await session.call("propose_ticket_priority", {
          customerId: a.customerId,
          ticketId: String(ticketId),
          priority: "high",
          rationale: "x",
        }),
      ).toMatchObject({ ok: false, error: /not verified/ });
      expect(
        await session.call("propose_refund_note", {
          refundStepId: `refund_${a.chargeIds[1]}`,
          ticketId: String(ticketId),
        }),
      ).toMatchObject({ ok: false, error: /not verified/ });
    }
    expect(session.actions).toHaveLength(1);
  });
  it("refuses equal legitimate payments for different invoices or unknown invoices", async () => {
    const { session, charges } = world();
    const c = caseOf("k01");
    const first = charges.get(c.chargeIds[0]) as Record<string, unknown>;
    const second = charges.get(c.chargeIds[1]) as Record<string, unknown>;
    second.amount = first.amount;
    const input = { chargeId: c.chargeIds[1], duplicateOfChargeId: c.chargeIds[0], rationale: "x" };
    expect(await session.call("propose_duplicate_refund", input)).toMatchObject({
      ok: false,
      error: /same invoice/,
    });
    first.invoice = null;
    second.invoice = null;
    expect(await session.call("propose_duplicate_refund", input)).toMatchObject({
      ok: false,
      error: /same invoice/,
    });
  });

  it("refunds only the two excess charges in a triple, rejecting reverse and cyclic pairs", async () => {
    const { session, charges } = world();
    const c = caseOf("c01");
    const second = charges.get(c.chargeIds[1]) as Record<string, unknown>;
    const thirdId = "ch_review_third";
    charges.set(thirdId, { ...second, id: thirdId, created: Number(second.created) + 90 });
    const propose = (chargeId: string, duplicateOfChargeId: string) =>
      session.call("propose_duplicate_refund", { chargeId, duplicateOfChargeId, rationale: "x" });
    expect((await propose(c.chargeIds[1], c.chargeIds[0])).ok).toBe(true);
    expect((await propose(c.chargeIds[0], thirdId)).ok).toBe(false);
    expect((await propose(thirdId, c.chargeIds[1])).ok).toBe(false);
    expect((await propose(thirdId, c.chargeIds[0])).ok).toBe(true);
    expect((await propose(c.chargeIds[0], c.chargeIds[1])).ok).toBe(false);
    expect(
      session.actions.map((a) => a.kind === "stripe.refund.create" && a.args.chargeId),
    ).toEqual([c.chargeIds[1], thirdId]);
    expect(evaluateBillingPolicy(session.manifest(META), POLICY).violations).toEqual([]);
  });
  it("exposes only typed inputs: no URL, tenant, method or free-form body", () => {
    const defs = planningToolDefinitions({ credits: true });
    expect(defs.map((d) => d.name).sort()).toEqual([
      "get_charge",
      "get_ticket",
      "list_customer_charges",
      "list_requester_tickets",
      "propose_balance_credit",
      "propose_customer_reply",
      "propose_duplicate_refund",
      "propose_refund_note",
      "propose_run_summary",
      "propose_ticket_priority",
    ]);
    const text = JSON.stringify(defs).toLowerCase();
    for (const word of ["url", "tenant", "method", "header", "world", "evidence"]) {
      expect(text).not.toContain(`"${word}`);
    }
    expect(CREDIT_TOOL_SCHEMA_HASH).toBe(fingerprint(defs));
    // Without credits the surface is exactly what it was before T1.14.
    const refundOnly = defs.filter((d) => d.name !== "propose_balance_credit");
    expect(planningToolDefinitions()).toEqual(refundOnly);
    expect(TOOL_SCHEMA_HASH).toBe(fingerprint(refundOnly));
  });

  it("rejects extra fields and malformed IDs before any read", async () => {
    const { session, reads } = world();
    const extra = await session.call("get_charge", {
      chargeId: "ch_x",
      baseUrl: "http://operational",
    });
    expect(extra.ok).toBe(false);
    expect((await session.call("get_ticket", { ticketId: "../admin" })).ok).toBe(false);
    expect((await session.call("http_get", { path: "/_admin/reset" })).ok).toBe(false);
    expect(reads).toEqual([]);
  });

  it("refuses to run against the operational world", () => {
    expect(
      () =>
        new PlanningSession({
          readers: { stripe: {} as PlanningReader, zendesk: {} as PlanningReader },
          ctx: { world: "operational", tenant: "x" },
          policy: POLICY,
          window: INCIDENT.window,
        }),
    ).toThrow(/planning world/);
  });

  it("records what each read exposed as evidence", async () => {
    const { session } = world();
    const c = caseOf("c01");
    const listed = await ok(session, "list_customer_charges", { customerId: c.customerId });
    expect(listed).toMatchObject({ complete: true, matchingIds: c.chargeIds });
    const charge = await ok(session, "get_charge", { chargeId: c.chargeIds[1] });
    expect(charge).toMatchObject({ evidenceId: `obs_charge_${c.chargeIds[1]}`, amount: 4210 });
    expect(session.queryObservations.map((q) => q.id)).toEqual([listed.evidenceId]);
    expect(session.observations.map((o) => o.id)).toEqual([charge.evidenceId]);
  });

  it("builds a refund, its evidence, its role and its note's dependency edge itself", async () => {
    const { session } = world();
    const small = caseOf("c01"); // 42.10 CAD
    const large = caseOf("c02"); // 125.00 CAD
    for (const c of [small, large]) {
      await ok(session, "propose_duplicate_refund", {
        chargeId: c.chargeIds[1],
        duplicateOfChargeId: c.chargeIds[0],
        rationale: `Second identical charge for ${c.invoices[0]}.`,
      });
      await ok(session, "propose_ticket_priority", {
        customerId: c.customerId,
        ticketId: String(c.ticketId),
        priority: "high",
        rationale: "Raise priority while the refund is in flight.",
      });
      await ok(session, "propose_refund_note", {
        refundStepId: `refund_${c.chargeIds[1]}`,
        ticketId: String(c.ticketId),
      });
    }

    const [refund, patch, note] = session.actions;
    expect(refund).toMatchObject({
      kind: "stripe.refund.create",
      caseId: `case_${small.customerId}`,
      requiredRole: "support_lead",
      dependsOn: [],
      evidence: [`obs_charge_${small.chargeIds[1]}`, `obs_charge_${small.chargeIds[0]}`],
      args: { chargeId: small.chargeIds[1], amount: { amountMinor: 4210, currency: "cad" } },
    });
    expect(refund?.queryEvidence).toHaveLength(1);
    expect(patch).toMatchObject({
      kind: "zendesk.ticket.patchFields",
      evidence: [`obs_ticket_${small.ticketId}`],
      args: { set: { priority: "high" }, before: { priority: "normal", status: "open" } },
    });
    expect(note).toMatchObject({
      kind: "zendesk.ticket.appendPrivateNote",
      dependsOn: [refund?.id],
      args: {
        bindings: {
          refundId: { $ref: "result", stepId: refund?.id, path: "refund.id" },
          amountMinor: 4210,
        },
      },
    });
    expect(session.actions[3]).toMatchObject({ requiredRole: "finance_lead" });

    const manifest = session.manifest(META);
    expect(PlanManifest.parse(manifest)).toEqual(manifest);
    expect(manifest.versions.planner.toolSchemaHash).toBe(TOOL_SCHEMA_HASH);
    expect(validateGraph(manifest.actions)).toEqual([]);
    expect(evaluateBillingPolicy(manifest, POLICY).violations).toEqual([]);
    // Every evidence ID an action cites is in the manifest.
    const ids = new Set([
      ...manifest.observations.map((o) => o.id),
      ...manifest.queryObservations.map((q) => q.id),
    ]);
    for (const a of manifest.actions) {
      for (const e of [...a.evidence, ...a.queryEvidence]) expect(ids).toContain(e);
    }
    expect(planHash(manifest)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses the three controls and a second remedy", async () => {
    const { session } = world();
    const refund = (key: string, i: 0 | 1 = 1) => {
      const c = caseOf(key);
      return session.call("propose_duplicate_refund", {
        chargeId: c.chargeIds[i],
        duplicateOfChargeId: c.chargeIds[1 - i],
        rationale: "duplicate",
      });
    };
    expect(await refund("k01")).toMatchObject({ ok: false, error: /not a duplicate/ });
    expect(await refund("k02")).toMatchObject({ ok: false, error: /refunds only cad/ });
    expect(await refund("k03")).toMatchObject({ ok: false, error: /inside the incident window/ });
    expect((await refund("c03")).ok).toBe(true);
    expect(await refund("c03")).toMatchObject({ ok: false, error: /already/ });
    // Refunding the other charge of the same pair is the same obligation.
    expect(await refund("c03", 0)).toMatchObject({ ok: false, error: /already remedied/ });
    expect(session.actions).toHaveLength(1);
  });

  it("won't attach ticket steps to a customer without a refund, or a note to a non-refund", async () => {
    const { session } = world();
    const c = caseOf("c04");
    expect(
      await session.call("propose_ticket_priority", {
        customerId: c.customerId,
        ticketId: String(c.ticketId),
        priority: "high",
        rationale: "x",
      }),
    ).toMatchObject({ ok: false, error: /refund for .* first/ });
    expect(
      await session.call("propose_refund_note", {
        refundStepId: "patch_1",
        ticketId: String(c.ticketId),
      }),
    ).toMatchObject({ ok: false, error: /not a proposed refund/ });
  });

  it("reports a failed read and records nothing for it", async () => {
    const { session } = world();
    const r = await session.call("get_charge", { chargeId: "ch_missing" });
    expect(r).toMatchObject({ ok: false, error: /read failed: .*404/ });
    expect(session.observations).toEqual([]);
  });
});

describe("propose_run_summary (T1.7)", () => {
  const TARGET = { channelId: "chan-general", incidentId: INCIDENT.incident };

  async function planned(session: PlanningSession) {
    const c = caseOf("c01");
    await ok(session, "propose_duplicate_refund", {
      chargeId: c.chargeIds[1],
      duplicateOfChargeId: c.chargeIds[0],
      rationale: "x",
    });
    await ok(session, "propose_refund_note", {
      refundStepId: `refund_${c.chargeIds[1]}`,
      ticketId: String(c.ticketId),
    });
    return c;
  }

  it("counts every step proposed before it, from a server-chosen channel and incident", async () => {
    const { session } = world({ runSummary: TARGET });
    const c = await planned(session);
    await ok(session, "propose_run_summary", {});
    const refund = `refund_${c.chargeIds[1]}`;
    const note = `note_${refund}`;
    expect(session.actions.at(-1)).toMatchObject({
      id: "run_summary",
      kind: "slack.message.postSummary",
      dependsOn: [refund, note],
      requiredRole: "support_lead",
      compensation: "irreversible",
      args: {
        channelId: "chan-general",
        template: { id: "run-summary", version: 1 },
        bindings: {
          incidentId: INCIDENT.incident,
          refunded: { stepIds: [refund], outcomes: ["confirmed"] },
          held: { stepIds: [refund, note] },
        },
      },
    });
    const manifest = session.manifest(META);
    expect(validateGraph(manifest.actions)).toEqual([]);
    expect(evaluateBillingPolicy(manifest, POLICY).violations).toEqual([]);
  });

  it("takes no input, so the model can't pick the channel or write the text", async () => {
    const { session } = world({ runSummary: TARGET });
    await planned(session);
    const r = await session.call("propose_run_summary", { channelId: "C_ELSEWHERE" });
    expect(r.ok).toBe(false);
  });

  it("must be last, once, and needs a refund and a configured channel", async () => {
    const off = world();
    await planned(off.session);
    expect(await off.session.call("propose_run_summary", {})).toMatchObject({
      ok: false,
      error: expect.stringContaining("no run summary channel"),
    });

    const empty = world({ runSummary: TARGET });
    expect(await empty.session.call("propose_run_summary", {})).toMatchObject({
      ok: false,
      error: expect.stringContaining("no refund"),
    });

    const { session } = world({ runSummary: TARGET });
    await planned(session);
    await ok(session, "propose_run_summary", {});
    expect((await session.call("propose_run_summary", {})).ok).toBe(false);
    const late = caseOf("c02");
    expect(
      await session.call("propose_duplicate_refund", {
        chargeId: late.chargeIds[1],
        duplicateOfChargeId: late.chargeIds[0],
        rationale: "x",
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("last step") });
  });
});

describe("propose_customer_reply (T1.13)", () => {
  async function refunded(session: PlanningSession, key = "c01") {
    const c = caseOf(key);
    await ok(session, "propose_duplicate_refund", {
      chargeId: c.chargeIds[1],
      duplicateOfChargeId: c.chargeIds[0],
      rationale: "x",
    });
    return { c, refund: `refund_${c.chargeIds[1]}` };
  }

  it("renders the approved template with the report's name, so the hash covers the exact text", async () => {
    const c01 = caseOf("c01");
    const { session } = world({ customerNames: { [c01.customerId]: c01.name } });
    const { c, refund } = await refunded(session);
    const r = await ok(session, "propose_customer_reply", {
      refundStepId: refund,
      ticketId: String(c.ticketId),
    });
    const reply = session.actions.at(-1);
    if (reply?.kind !== "zendesk.ticket.appendPublicReply") throw new Error("no reply");
    expect(reply).toMatchObject({
      id: `reply_${refund}`,
      caseId: `case_${c.customerId}`,
      dependsOn: [refund],
      requiredRole: "support_lead",
      compensation: "irreversible",
      args: {
        ticketId: String(c.ticketId),
        public: true,
        template: { id: "refund-issued", version: 1 },
        values: { customerName: c01.name, amountMinor: c01.amountMinor },
      },
    });
    expect(reply.args.body).toContain(`Hi ${c01.name},`);
    // The executor re-renders it and must get the same bytes; the model sees what it proposed.
    expect(replyBodyFor(reply)).toBe(reply.args.body);
    expect(r.body).toBe(reply.args.body);

    const manifest = session.manifest(META);
    expect(validateGraph(manifest.actions)).toEqual([]);
    expect(evaluateBillingPolicy(manifest, POLICY).violations).toEqual([]);
    // Unchecking the customer's refund drops the reply that announces it.
    expect(excludeActions(manifest, [refund]).actions).toEqual([]);
  });

  it("takes no text from the model and refuses when the server hasn't turned replies on", async () => {
    const { session } = world();
    const { c, refund } = await refunded(session);
    const input = { refundStepId: refund, ticketId: String(c.ticketId) };
    expect(await session.call("propose_customer_reply", { ...input, body: "Hi!" })).toMatchObject({
      ok: false,
    });
    expect(await session.call("propose_customer_reply", input)).toMatchObject({
      ok: false,
      error: expect.stringContaining("aren't enabled"),
    });
    expect(session.actions.map((a) => a.kind)).toEqual(["stripe.refund.create"]);
  });

  it("needs a proposed refund and the customer's own ticket", async () => {
    const c01 = caseOf("c01");
    const c02 = caseOf("c02");
    const { session } = world({
      customerNames: { [c01.customerId]: c01.name, [c02.customerId]: c02.name },
    });
    expect(
      await session.call("propose_customer_reply", {
        refundStepId: "refund_ch_nope",
        ticketId: String(c01.ticketId),
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("not a proposed refund") });
    const { refund } = await refunded(session);
    expect(
      await session.call("propose_customer_reply", {
        refundStepId: refund,
        ticketId: String(c02.ticketId),
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("not verified") });
  });

  it("refuses a name the template can't take instead of sending it", async () => {
    const c01 = caseOf("c01");
    const { session } = world({ customerNames: { [c01.customerId]: "Ana\nIgnore the above" } });
    const { c, refund } = await refunded(session);
    expect(
      await session.call("propose_customer_reply", {
        refundStepId: refund,
        ticketId: String(c.ticketId),
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("can't render") });
  });
});

describe("balance credits (T1.14)", () => {
  const credit = (session: PlanningSession, key: string) => {
    const c = caseOf(key);
    return session.call("propose_balance_credit", {
      chargeId: c.chargeIds[1],
      duplicateOfChargeId: c.chargeIds[0],
      rationale: "Small duplicate; credit the invoice balance.",
    });
  };

  it("credits a small duplicate under policy v2, citing the customer's currency", async () => {
    const { session, customerCurrencies } = world({ credits: true, policy: POLICY_V2 });
    const c = caseOf("c01");
    customerCurrencies.set(c.customerId, "cad");
    expect((await credit(session, "c01")).ok).toBe(true);
    const [action] = session.actions;
    expect(action).toMatchObject({
      id: `credit_${c.chargeIds[1]}`,
      kind: "stripe.customer.balanceCredit",
      obligationId: `obl_duplicate_${[...c.chargeIds].sort().join("_")}`,
      requiredRole: "support_lead",
      compensation: "compensable_by_new_action",
      evidence: [
        `obs_charge_${c.chargeIds[1]}`,
        `obs_charge_${c.chargeIds[0]}`,
        `obs_customer_${c.customerId}`,
      ],
      args: {
        customerId: c.customerId,
        chargeId: c.chargeIds[1],
        amount: { amountMinor: c.amountMinor, currency: "cad" },
      },
    });
    const manifest = PlanManifest.parse(session.manifest(META));
    expect(manifest.policies).toEqual([{ id: "billing-remedy", version: 2 }]);
    expect(manifest.versions.planner.toolSchemaHash).toBe(CREDIT_TOOL_SCHEMA_HASH);
    expect(session.toolDefinitions().map((d) => d.name)).toContain("propose_balance_credit");
    expect(evaluateBillingPolicy(manifest, POLICY_V2).violations).toEqual([]);
    expect(validateGraph(manifest.actions)).toEqual([]);
  });

  it("credits a customer Stripe hasn't given a currency yet", async () => {
    const { session } = world({ credits: true, policy: POLICY_V2 });
    expect((await credit(session, "c01")).ok).toBe(true);
  });

  it("refuses unless the server turned credits on and the policy has a credit limit", async () => {
    expect(await credit(world({ policy: POLICY_V2 }).session, "c01")).toMatchObject({
      ok: false,
      error: expect.stringContaining("balance credits are off"),
    });
    expect(await credit(world({ credits: true }).session, "c01")).toMatchObject({
      ok: false,
      error: expect.stringContaining("billing-remedy@1 has no invoice credit"),
    });
  });

  it("refuses a credit at or above the policy limit", async () => {
    const { session } = world({ credits: true, policy: POLICY_V2 });
    expect(caseOf("c02").amountMinor).toBeGreaterThanOrEqual(POLICY_V2.creditMaxMinor);
    expect(await credit(session, "c02")).toMatchObject({
      ok: false,
      error: expect.stringContaining("a credit must be below 10000 cad"),
    });
    expect(session.actions).toEqual([]);
  });

  it("refuses a credit in a currency other than the customer's (Era wouldn't)", async () => {
    const { session, customerCurrencies } = world({ credits: true, policy: POLICY_V2 });
    customerCurrencies.set(caseOf("c01").customerId, "usd");
    expect(await credit(session, "c01")).toMatchObject({
      ok: false,
      error: expect.stringContaining("is billed in usd"),
    });
    expect(session.actions).toEqual([]);
  });

  it("proposes one remedy per obligation: a credit or a refund, never both", async () => {
    const c = caseOf("c01");
    const refund = (session: PlanningSession, chargeId: string, duplicateOf: string) =>
      session.call("propose_duplicate_refund", {
        chargeId,
        duplicateOfChargeId: duplicateOf,
        rationale: "x",
      });

    const first = world({ credits: true, policy: POLICY_V2 }).session;
    expect((await credit(first, "c01")).ok).toBe(true);
    expect(await refund(first, c.chargeIds[1], c.chargeIds[0])).toMatchObject({
      ok: false,
      error: expect.stringContaining(`already remedied by credit_${c.chargeIds[1]}`),
    });

    const second = world({ credits: true, policy: POLICY_V2 }).session;
    expect((await refund(second, c.chargeIds[1], c.chargeIds[0])).ok).toBe(true);
    expect(await credit(second, "c01")).toMatchObject({
      ok: false,
      error: expect.stringContaining(`already remedied by refund_${c.chargeIds[1]}`),
    });
    expect(second.actions).toHaveLength(1);
  });

  it("lets the ticket priority follow a credit", async () => {
    const { session } = world({ credits: true, policy: POLICY_V2 });
    const c = caseOf("c01");
    expect((await credit(session, "c01")).ok).toBe(true);
    const r = await session.call("propose_ticket_priority", {
      customerId: c.customerId,
      ticketId: String(c.ticketId),
      priority: "urgent",
      rationale: "x",
    });
    expect(r).toMatchObject({ ok: true });
    expect(session.actions.at(-1)?.obligationId).toBe(session.actions[0]?.obligationId);
  });
});
