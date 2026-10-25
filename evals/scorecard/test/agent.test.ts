import { PlanningSession } from "@rehearsal/planner";
import { INCIDENT } from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import { policyFor, proposedByCase, runAgent, sessionOps } from "../src/agent";
import { TASKS } from "../src/tasks";
import { planningWorld } from "./planning-world";

const byId = (id: string) => {
  const task = TASKS.find((t) => t.id === id);
  if (!task) throw new Error(`no task ${id}`);
  return task;
};

async function plan(id: string) {
  const task = byId(id);
  const { readers, records } = planningWorld();
  const session = new PlanningSession({
    readers,
    ctx: { world: "planning", tenant: "sc-test" },
    policy: policyFor(task),
    window: INCIDENT.window,
    ...sessionOps(task),
  });
  const result = await runAgent(task, records.cases, session, {
    orgId: "org_test",
    incidentId: INCIDENT.incident,
    planId: `plan_${id}`,
    adapters: {},
  });
  return { task, ...result };
}

describe("scripted agent on the full operation set (T1.27)", () => {
  it("plans credits, refunds with notes and replies, and one summary last (F1)", async () => {
    const { manifest, intents } = await plan("F1");
    expect(intents.filter((i) => !i.accepted)).toEqual([]);
    const kinds = manifest.actions.map((a) => a.kind);
    const count = (k: string) => kinds.filter((x) => x === k).length;
    expect(count("stripe.customer.balanceCredit")).toBe(2);
    expect(count("stripe.refund.create")).toBe(6);
    expect(count("zendesk.ticket.patchFields")).toBe(8);
    expect(count("zendesk.ticket.appendPrivateNote")).toBe(6);
    expect(count("zendesk.ticket.appendPublicReply")).toBe(6);
    expect(kinds.at(-1)).toBe("slack.message.postSummary");
    expect(manifest.policies).toEqual([{ id: "billing-remedy", version: 2 }]);
  });

  it("leaves an omitted case out without any refusal (F7)", async () => {
    const { task, intents, coverage } = await plan("F7");
    expect(coverage).toEqual([
      {
        kind: "unexamined",
        customerId: INCIDENT.cases.find((c) => c.key === "c05")?.customerId,
        chargeIds: [],
      },
    ]);
    expect(intents.filter((i) => !i.accepted)).toEqual([]);
    const proposed = proposedByCase(intents, Object.keys(task.gold));
    expect(proposed.c05).toEqual({ refunds: 0, credits: 0, priority: 0, notes: 0, replies: 0 });
    expect(proposed.c01).toEqual({ refunds: 1, credits: 0, priority: 1, notes: 1, replies: 1 });
  });

  it("has the second remedy for one obligation refused, with what depends on it (F8)", async () => {
    const { intents } = await plan("F8");
    const c03 = intents.filter((i) => i.intent.caseKey === "c03");
    expect(c03.map((i) => [i.intent.tool, i.accepted])).toEqual([
      ["propose_balance_credit", true],
      ["propose_duplicate_refund", false],
      ["propose_ticket_priority", true],
      ["propose_refund_note", false],
      ["propose_customer_reply", false],
    ]);
  });

  it("plans the tasks from before T1.27 under policy v1 with no new ops (B1)", async () => {
    const { manifest } = await plan("B1");
    expect(manifest.policies).toEqual([{ id: "billing-remedy", version: 1 }]);
    expect(new Set(manifest.actions.map((a) => a.kind))).toEqual(
      new Set([
        "stripe.refund.create",
        "zendesk.ticket.patchFields",
        "zendesk.ticket.appendPrivateNote",
      ]),
    );
  });
});
