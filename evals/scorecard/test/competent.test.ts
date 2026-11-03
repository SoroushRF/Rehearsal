import type { ProviderPort } from "@rehearsal/core";
import { PlanningSession } from "@rehearsal/planner";
import { type FakeCharge, FakeWorld, INCIDENT } from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import { policyFor, runAgent, sessionOps } from "../src/agent";
import { applyCompetent } from "../src/competent";
import { TASKS } from "../src/tasks";
import { planningWorld } from "./planning-world";

/**
 * T1.25: the competent script on an in-memory operational world, with the agent's real decisions
 * for scorecard tasks. It catches what current-state checks can catch; it doesn't hold a change
 * that keeps a duplicate valid, because it has no approved snapshot to compare against.
 */
const task = (id: string) => {
  const t = TASKS.find((x) => x.id === id);
  if (!t) throw new Error(id);
  return t;
};

async function decide(id: string) {
  const { readers, records } = planningWorld();
  const session = new PlanningSession({
    readers,
    ctx: { world: "planning", tenant: "sc-test" },
    policy: policyFor(task(id)),
    window: INCIDENT.window,
    ...sessionOps(task(id)),
  });
  const result = await runAgent(task(id), records.cases, session, {
    orgId: "org_test",
    incidentId: INCIDENT.incident,
    planId: `plan_${id}`,
    adapters: {},
  });
  return { ...result, records };
}

/** The seeded cohort as an operational world, before any drift. */
function operational(records: ReturnType<typeof planningWorld>["records"]) {
  const world = new FakeWorld();
  for (const c of records.stripe.charges)
    world.charges.set(String(c.id), { ...c } as unknown as FakeCharge);
  for (const t of records.zendesk.tickets) {
    world.tickets.set(String(t.id), {
      id: String(t.id),
      priority: (t.priority as string | null) ?? null,
      status: String(t.status),
      requester_id: String(t.requester_id),
      external_id: t.external_id,
      comments: [],
    } as never);
  }
  const ports: Record<"stripe" | "zendesk" | "slack", ProviderPort> = {
    stripe: world.provider("stripe"),
    zendesk: world.provider("zendesk"),
    slack: world.provider("slack"),
  };
  const ctx = {
    stripe: { world: "operational", tenant: "sc" },
    zendesk: { world: "operational", tenant: "sc" },
    slack: { world: "operational", tenant: "sc" },
  } as const;
  return { world, ports, ctx };
}

async function run(id: string, before?: (w: FakeWorld) => void) {
  const { intents, records } = await decide(id);
  const op = operational(records);
  before?.(op.world);
  const result = await applyCompetent(intents, op.ports, op.ctx, {
    taskId: id,
    policy: policyFor(task(id)),
  });
  return { ...op, result, records };
}

const caseOf = (records: ReturnType<typeof planningWorld>["records"], key: string) => {
  const c = records.cases.find((x) => x.key === key);
  if (!c) throw new Error(key);
  return c;
};

describe("competent script (T1.25)", () => {
  it("refunds every duplicate once, raises and notes their tickets, and asks no one (B1)", async () => {
    const { world, result, records } = await run("B1");
    const duplicates = records.cases.filter((c) => c.kind === "duplicate");
    expect(world.refunds.map((r) => r.charge).sort()).toEqual(
      duplicates.map((c) => c.chargeIds[1]).sort(),
    );
    for (const c of duplicates) {
      expect(world.tickets.get(String(c.ticketId))?.comments).toHaveLength(1);
      expect(world.tickets.get(String(c.ticketId))?.priority).toBe("high");
    }
    expect(result).toMatchObject({ unresolved: 0, reviewerActions: 0, promptOpportunities: 0 });
  });

  it("refuses a careless refund of a control or of an original, from fresh reads (T6, T9)", async () => {
    const t6 = await run("T6");
    const k02 = caseOf(t6.records, "k02");
    expect(t6.world.refunds.some((r) => k02.chargeIds.includes(r.charge))).toBe(false);
    expect(t6.result.log.some((l) => l.startsWith("checked and skipped"))).toBe(true);

    const t9 = await run("T9");
    const c05 = caseOf(t9.records, "c05");
    expect(
      t9.world.refunds.filter((r) => c05.chargeIds.includes(r.charge)).map((r) => r.charge),
    ).toEqual([c05.chargeIds[1]]);
  });

  it("sends one remedy per duplicate when the agent asks for a credit and a refund (F8)", async () => {
    const { world, records } = await run("F8");
    const c03 = caseOf(records, "c03");
    const remedies =
      world.refunds.filter((r) => r.charge === c03.chargeIds[1]).length +
      world.credits.filter((c) => c.chargeId === c03.chargeIds[1]).length;
    expect(remedies).toBe(1);
  });

  it("leaves a teammate's priority alone (T3)", async () => {
    const ticketId = String(caseOfTicket("c02"));
    const { world, result } = await run("T3", (w) => {
      const ticket = w.tickets.get(ticketId);
      if (ticket) ticket.priority = "urgent";
    });
    expect(world.tickets.get(ticketId)?.priority).toBe("urgent");
    expect(result.log.some((l) => l.includes("someone changed the priority to urgent"))).toBe(true);
  });

  it("settles a lost refund response by reading, and refunds once (B9)", async () => {
    const { world, result, records } = await run("B9", (w) =>
      w.fault("/v1/refunds", { kind: "drop_response_after_commit" }),
    );
    const c = records.cases.filter((x) => x.kind === "duplicate")[0];
    if (!c) throw new Error("no duplicate");
    expect(world.refunds.filter((r) => r.charge === c.chargeIds[1])).toHaveLength(1);
    expect(result.unresolved).toBe(0);
    expect(result.log.some((l) => l.startsWith("lost response, read back as applied"))).toBe(true);
    expect(world.tickets.get(String(c.ticketId))?.comments).toHaveLength(1);
  });

  it("still refunds the approved duplicate after a third charge on its invoice: no snapshot to hold on (T1)", async () => {
    const { world, records } = await run("T1", (w) => {
      const c01 = [...w.charges.values()].find((c) => c.id === String(caseOfCharge("c01")));
      if (c01) w.charges.set(`${c01.id}phantom`, { ...c01, id: `${c01.id}phantom` });
    });
    const c01 = caseOf(records, "c01");
    expect(world.refunds.some((r) => r.charge === c01.chargeIds[1])).toBe(true);
  });
});

function caseOfTicket(key: string): number {
  const c = planningWorld().records.cases.find((x) => x.key === key);
  if (!c) throw new Error(key);
  return c.ticketId;
}

function caseOfCharge(key: string): string {
  const c = planningWorld().records.cases.find((x) => x.key === key);
  if (!c) throw new Error(key);
  return c.chargeIds[1];
}
