import { PlanManifest } from "@rehearsal/contracts";
import {
  evaluateBillingPolicy,
  fingerprint,
  guardAction,
  planHash,
  validateGraph,
} from "@rehearsal/core";
import { STRIPE_CHARGE_PROJECTION, ZENDESK_TICKET_PROJECTION } from "@rehearsal/providers";
import { INCIDENT, incidentRecords } from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import {
  type PlanningReader,
  PlanningSession,
  planningToolDefinitions,
  TOOL_SCHEMA_HASH,
} from "../src";
import { POLICY, world } from "./world";

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
    const defs = planningToolDefinitions();
    expect(defs.map((d) => d.name).sort()).toEqual([
      "get_charge",
      "get_ticket",
      "list_customer_charges",
      "list_requester_tickets",
      "propose_duplicate_refund",
      "propose_refund_note",
      "propose_ticket_priority",
    ]);
    const text = JSON.stringify(defs).toLowerCase();
    for (const word of ["url", "tenant", "method", "header", "world", "evidence"]) {
      expect(text).not.toContain(`"${word}`);
    }
    expect(TOOL_SCHEMA_HASH).toBe(fingerprint(defs));
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
