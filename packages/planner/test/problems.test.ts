import { Action } from "@rehearsal/contracts";
import {
  evaluateBillingPolicy,
  noteBodyFor,
  replyBodyFor,
  summaryCountKey,
  summaryTextFor,
  validateGraph,
} from "@rehearsal/core";
import { INCIDENT, problemRecords } from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import { BACKLOG_TOOL_SCHEMA_HASH, BACKLOG_TOOLS, type PlanningSession } from "../src";
import { POLICY, world } from "./world";

/** Live demo (#331): the records "create a problem" injects, planned like any other world. */

const roster = (key: string) => {
  const c = INCIDENT.cases.find((x) => x.key === key);
  if (!c) throw new Error(key);
  return c;
};

async function ok(session: PlanningSession, name: string, input: unknown) {
  const r = await session.call(name, input);
  if (!r.ok) throw new Error(`${name}: ${r.error}`);
  return r.result as Record<string, unknown>;
}

const META = {
  orgId: "org_demo",
  incidentId: "INC-BACKLOG-0042",
  planId: "plan_backlog",
  model: "test",
  promptVersion: "test",
  adapters: {},
};

describe("a duplicate_charge problem", () => {
  it("gives a control customer a real duplicate the billing tools refund", async () => {
    const extra = problemRecords("duplicate_charge", 2, "t1", 9_300_000);
    if (!extra) throw new Error("no preset");
    expect(extra.zendesk.tickets).toEqual([]);
    const { session } = world({}, extra);
    const k03 = roster("k03");
    const [first, second] = extra.stripe.charges.filter((c) => c.customer === k03.customerId);
    if (!first || !second) throw new Error("no pair for k03");

    await ok(session, "list_customer_charges", { customerId: k03.customerId });
    expect(session.coverage([k03.customerId])).toEqual([
      {
        kind: "missing_remedy",
        customerId: k03.customerId,
        chargeIds: [String(first.id), String(second.id)],
      },
    ]);
    await ok(session, "propose_duplicate_refund", {
      chargeId: second.id,
      duplicateOfChargeId: first.id,
      rationale: "Charged twice for one invoice.",
    });
    expect(session.coverage([k03.customerId])).toEqual([]);
  });

  it("stamps every ID, so a second request adds records instead of colliding", () => {
    const a = problemRecords("duplicate_charge", 5, "a1", 9_300_000);
    const b = problemRecords("duplicate_charge", 5, "b2", 9_300_000);
    const ids = [...(a?.stripe.charges ?? []), ...(b?.stripe.charges ?? [])].map((c) => c.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
    expect(() => problemRecords("duplicate_charge", 1, "no-dashes", 1)).toThrow();
    expect(problemRecords("service_outage", 1, "x", 1)).toBeUndefined();
  });
});

describe("a support_backlog session", () => {
  const extra = problemRecords("support_backlog", 2, "t1", 9_300_000);
  if (!extra) throw new Error("no preset");
  const k01 = roster("k01");
  const k02 = roster("k02");
  const waiting = String(extra.zendesk.tickets[0]?.id);
  const names = { [k01.customerId]: k01.name, [k02.customerId]: k02.name };
  const backlog = () =>
    world(
      {
        mode: "backlog",
        customerNames: names,
        runSummary: { channelId: "C_SUMMARY", incidentId: META.incidentId },
      },
      extra,
    );

  it("offers only the ticket tools, under their own schema hash", async () => {
    const { session } = backlog();
    expect(session.toolDefinitions().map((t) => t.name)).toEqual(Object.keys(BACKLOG_TOOLS));
    expect(session.manifest(META).versions.planner.toolSchemaHash).toBe(BACKLOG_TOOL_SCHEMA_HASH);
    const refund = await session.call("propose_duplicate_refund", {
      chargeId: "ch_x",
      duplicateOfChargeId: "ch_y",
      rationale: "x",
    });
    expect(refund).toEqual({ ok: false, error: "unknown tool propose_duplicate_refund" });
  });

  it("follows up a waiting ticket: priority, then note, then the reply, then the summary", async () => {
    const { session } = backlog();
    const customers = [{ customerId: k01.customerId, requesterId: String(k01.requesterId) }];
    expect(session.coverageOf(customers)).toEqual([
      { kind: "unexamined", customerId: k01.customerId, chargeIds: [] },
    ]);
    await ok(session, "list_requester_tickets", { requesterId: String(k01.requesterId) });
    expect(session.coverageOf(customers)).toEqual([
      { kind: "missing_remedy", customerId: k01.customerId, chargeIds: [], ticketIds: [waiting] },
    ]);

    const ids = { customerId: k01.customerId, ticketId: waiting };
    await ok(session, "propose_ticket_priority", { ...ids, priority: "high", rationale: "New." });
    await ok(session, "propose_ticket_note", ids);
    const reply = await ok(session, "propose_customer_reply", ids);
    expect(reply.body).toContain(`Hi ${k01.name},`);
    // The reply comes last: nothing more for this ticket once it is proposed.
    const late = await session.call("propose_ticket_priority", {
      ...ids,
      priority: "urgent",
      rationale: "x",
    });
    expect(late).toMatchObject({ ok: false, error: expect.stringContaining("has to come last") });
    await ok(session, "propose_run_summary", {});
    expect(session.coverageOf(customers)).toEqual([]);

    const actions = session.actions;
    expect(actions.map((a) => [a.id, a.dependsOn])).toEqual([
      [`patch_${waiting}`, []],
      [`note_${waiting}`, [`patch_${waiting}`]],
      [`reply_${waiting}`, [`patch_${waiting}`, `note_${waiting}`]],
      ["run_summary", [`patch_${waiting}`, `note_${waiting}`, `reply_${waiting}`]],
    ]);
    for (const a of actions) Action.parse(a);
    expect(validateGraph(actions)).toEqual([]);
    expect(evaluateBillingPolicy({ actions }, POLICY).violations).toEqual([]);

    const note = actions.find((a) => a.kind === "zendesk.ticket.appendPrivateNote");
    const sent = actions.find((a) => a.kind === "zendesk.ticket.appendPublicReply");
    const summary = actions.find((a) => a.kind === "slack.message.postSummary");
    if (!note || !sent || !summary) throw new Error("missing step");
    expect(noteBodyFor(note, new Map(), "op_1")).toMatch(/^Flagged in a support backlog review/);
    expect(replyBodyFor(sent)).toBe(reply.body);
    const counts = new Map([
      [summaryCountKey("followedUp"), 1],
      [summaryCountKey("held"), 0],
    ]);
    expect(summaryTextFor(summary, counts, "op_2")).toMatch(
      /^Support backlog INC-BACKLOG-0042: 1 ticket\(s\) followed up, 0 step\(s\) held for review\./,
    );
  });

  it("leaves tickets the team is already handling and refuses to lower a priority", async () => {
    const { session, records } = backlog();
    const seeded = records.zendesk.tickets.find((t) => t.requester_id === k01.requesterId);
    const handled = await session.call("propose_ticket_note", {
      customerId: k01.customerId,
      ticketId: String(seeded?.id),
    });
    expect(handled).toMatchObject({ ok: false, error: expect.stringContaining("is open") });
    const lower = await session.call("propose_ticket_priority", {
      customerId: k01.customerId,
      ticketId: waiting,
      priority: "low",
      rationale: "x",
    });
    expect(lower).toMatchObject({ ok: false, error: expect.stringContaining("only raise") });
    const theirs = await session.call("propose_ticket_note", {
      customerId: k02.customerId,
      ticketId: waiting,
    });
    expect(theirs).toMatchObject({ ok: false, error: expect.stringContaining("not verified") });
  });
});
