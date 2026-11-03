import type { PlanManifest } from "@rehearsal/contracts";
import {
  type BillingPolicyV1,
  checkRepair,
  createReadGuard,
  type ExecutorDeps,
  executeRun,
  fingerprint,
  type ProviderPort,
  planHash,
  repairScope,
} from "@rehearsal/core";
import {
  STRIPE_CHARGE_PROJECTION,
  stripeChargeProjection,
  ZENDESK_TICKET_PROJECTION,
  zendeskTicketProjection,
} from "@rehearsal/providers";
import {
  approvedGrant,
  type FakeCharge,
  FakeClock,
  fakeRunAdmit,
  INCIDENT,
  incidentRecords,
  MemoryApplyStore,
  MemoryJournal,
  worldFromManifest,
} from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import policyV1 from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import { briefMessage, keptSteps, type PlanningSession, repairBrief } from "../src";
import { world } from "./world";

/**
 * T1.37 end to end on fakes: plan two customers, apply with a phantom charge that appeared after
 * approval, repair the held case on a refreshed planning copy, apply the repair. The real planning
 * tools, the real executor and its read guard; only the worlds are in memory.
 */
const META = {
  orgId: "org_demo",
  incidentId: INCIDENT.incident,
  planId: "plan_repair",
  model: "test",
  promptVersion: "test",
  adapters: { stripe: STRIPE_CHARGE_PROJECTION, zendesk: ZENDESK_TICKET_PROJECTION },
};
const caseOf = (key: string) => {
  const c = incidentRecords().cases.find((x) => x.key === key);
  if (!c) throw new Error(key);
  return c;
};
const C01 = caseOf("c01");
const C02 = caseOf("c02");
const PHANTOM = `${C01.chargeIds[1]}phantom`;

async function ok(session: PlanningSession, name: string, input: unknown) {
  const r = await session.call(name, input);
  if (!r.ok) throw new Error(`${name}: ${r.error}`);
  return r.result;
}

/** Refund the duplicate, raise the ticket, note the refund: what the scripted planner does per case. */
async function planCase(session: PlanningSession, c: ReturnType<typeof caseOf>) {
  await ok(session, "propose_duplicate_refund", {
    chargeId: c.chargeIds[1],
    duplicateOfChargeId: c.chargeIds[0],
    rationale: "duplicate",
  });
  await ok(session, "propose_ticket_priority", {
    customerId: c.customerId,
    ticketId: String(c.ticketId),
    priority: "high",
    rationale: "refund in flight",
  });
  await ok(session, "propose_refund_note", {
    refundStepId: `refund_${c.chargeIds[1]}`,
    ticketId: String(c.ticketId),
  });
}

/** A copy of the case's duplicate charge with another ID: same invoice, amount and window. */
function phantomOf(charges: Map<string, Record<string, unknown>>) {
  const dup = charges.get(C01.chargeIds[1]);
  if (!dup) throw new Error("no duplicate");
  return { ...dup, id: PHANTOM, created: Number(dup.created) + 60 };
}

/** The fake operational world, read through the same projections as the planning readers. */
function realProjections(p: ProviderPort): ProviderPort {
  return {
    ...p,
    observe: async (entity, ctx) => {
      const o = await p.observe(entity, ctx);
      if (entity.kind !== "charge" && entity.kind !== "ticket") return o;
      const projection =
        entity.kind === "charge"
          ? stripeChargeProjection(o.projection)
          : zendeskTicketProjection(o.projection);
      return {
        ...o,
        projection,
        projectionVersion:
          entity.kind === "charge" ? STRIPE_CHARGE_PROJECTION : ZENDESK_TICKET_PROJECTION,
        fingerprint: fingerprint(projection),
      };
    },
    query: async (predicate, cutoff, ctx) => {
      const q = await p.query(predicate, cutoff, ctx);
      const projections = Object.fromEntries(
        Object.entries(q.projections).map(([id, c]) => [id, stripeChargeProjection(c)]),
      );
      return {
        ...q,
        projections,
        projectionVersion: STRIPE_CHARGE_PROJECTION,
        fingerprint: fingerprint({ matchingIds: q.matchingIds, projections }),
      };
    },
  };
}

function executor(r1: PlanManifest) {
  const clock = new FakeClock("2026-10-21T12:00:00.000Z");
  const store = new MemoryApplyStore();
  const operational = worldFromManifest(r1.observations);
  const providers: Record<"stripe" | "zendesk", ProviderPort> = {
    stripe: realProjections(operational.provider("stripe")),
    zendesk: realProjections(operational.provider("zendesk")),
  };
  const worlds = {
    stripe: { world: "operational", tenant: "test" },
    zendesk: { world: "operational", tenant: "test" },
  } as const;
  let n = 0;
  const journal = new MemoryJournal();
  const deps: ExecutorDeps = {
    store,
    journal,
    clock,
    providers,
    worlds,
    policies: [policyV1 as BillingPolicyV1],
    admit: fakeRunAdmit({ now: () => clock.now() }),
    newId: (prefix: string) => `${prefix}_${++n}`,
    guard: createReadGuard({ providers, worlds, clock }),
  };
  /** Store a revision with its own approval and run, then apply it. */
  const apply = (m: PlanManifest) => {
    const hash = planHash(m);
    const run = `run_${m.revision}`;
    const grantId = `grant_${m.revision}`;
    store.plans.set(`${m.planId}@${m.revision}`, { planHash: hash, manifest: m });
    store.runs.set(run, {
      planId: m.planId,
      revision: m.revision,
      planHash: hash,
      approvalId: grantId,
    });
    store.grants.set(
      grantId,
      approvedGrant({
        id: grantId,
        orgId: m.orgId,
        planId: m.planId,
        revision: m.revision,
        planHash: hash,
        actorUserId: "user_finance",
        actorSessionId: "sess_1",
        roles: ["support_lead", "finance_lead"],
        grantedAt: "2026-10-21T11:00:00.000Z",
        expiresAt: "2026-10-21T13:00:00.000Z",
        revokedAt: null,
      }),
    );
    return executeRun(
      { orgId: m.orgId, runId: run, planId: m.planId, revision: m.revision, planHash: hash },
      deps,
    );
  };
  return { operational, journal, apply };
}

const outcomes = (receipts: { actionId: string; outcome: string }[]) =>
  Object.fromEntries(receipts.map((r) => [r.actionId, r.outcome]));

describe("repairing a held run (T1.37)", () => {
  it("refunds the phantom too, keeps what went out, and sends nothing twice", async () => {
    const planning = world();
    await planCase(planning.session, C01);
    await planCase(planning.session, C02);
    const r1 = planning.session.manifest(META);
    const exec = executor(r1);

    // After approval, a second duplicate of c01's invoice appears in the operational world only.
    exec.operational.charges.set(PHANTOM, phantomOf(planning.charges) as unknown as FakeCharge);
    const run1 = await exec.apply(r1);
    const refund01 = `refund_${C01.chargeIds[1]}`;
    expect(outcomes(run1.receipts)).toMatchObject({
      [refund01]: "held",
      [`patch_${C01.ticketId}`]: "confirmed",
      [`note_${refund01}`]: "skipped_dependency",
      [`refund_${C02.chargeIds[1]}`]: "confirmed",
    });

    const receipts = await exec.journal.receiptsFor(planHash(r1));
    const scope = repairScope(r1, receipts, []);
    if (!scope.ok) throw new Error(scope.reason);
    expect(scope.openCases).toEqual([`case_${C01.customerId}`]);
    expect(scope.refresh).toEqual([{ vendor: "stripe", kind: "charge", id: PHANTOM }]);
    expect(scope.replanned.sort()).toEqual([refund01, `note_${refund01}`].sort());

    // The API copies what the hold found into the planning world; the planner plans c01 again.
    const repair = {
      base: r1,
      basePlanHash: planHash(r1),
      runId: "run_1",
      kept: scope.kept,
      openCases: scope.openCases,
      stopped: [{ id: refund01, why: `held: ${PHANTOM} newly matched its query` }],
    };
    const replanning = world({ summaryId: "run_summary_r2" });
    replanning.charges.set(PHANTOM, phantomOf(planning.charges));
    replanning.session.adopt(keptSteps(repair));
    const brief = repairBrief(
      {
        incident: INCIDENT.incident,
        summary: "x",
        window: INCIDENT.window,
        customers: [C01, C02].map((c) => ({
          customerId: c.customerId,
          name: c.name,
          requesterId: String(c.requesterId),
        })),
      },
      repair,
    );
    expect(brief?.customers.map((c) => c.customerId)).toEqual([C01.customerId]);
    expect(briefMessage(brief as NonNullable<typeof brief>)).toContain(
      `patch_${C01.ticketId}: zendesk.ticket.patchFields`,
    );

    // The priority already went out: proposing it again is refused, not duplicated.
    expect(
      await replanning.session.call("propose_ticket_priority", {
        customerId: C01.customerId,
        ticketId: String(C01.ticketId),
        priority: "high",
        rationale: "again",
      }),
    ).toMatchObject({ ok: false, error: /already applied by an earlier revision/ });
    for (const charge of [C01.chargeIds[1], PHANTOM]) {
      await ok(replanning.session, "propose_duplicate_refund", {
        chargeId: charge,
        duplicateOfChargeId: C01.chargeIds[0],
        rationale: "duplicate",
      });
      await ok(replanning.session, "propose_refund_note", {
        refundStepId: `refund_${charge}`,
        ticketId: String(C01.ticketId),
      });
    }
    expect(replanning.session.coverage([C01.customerId])).toEqual([]);
    const r2 = replanning.session.manifest({ ...META, repairOf: r1 });
    expect(r2).toMatchObject({ revision: 2, parentRevision: 1 });
    expect(checkRepair(r1, scope, r2)).toEqual([]);
    expect(planHash(r2)).not.toBe(planHash(r1));

    const sentBefore = {
      refunds: exec.operational.refunds.length,
      comments: exec.operational.tickets.get(String(C02.ticketId))?.comments.length,
    };
    const run2 = await exec.apply(r2);
    expect(run2.state).toBe("completed");
    expect(outcomes(run2.receipts)).toMatchObject({
      [refund01]: "confirmed",
      [`refund_${PHANTOM}`]: "confirmed",
      [`note_${refund01}`]: "confirmed",
      [`note_refund_${PHANTOM}`]: "confirmed",
      [`patch_${C01.ticketId}`]: "confirmed",
      [`refund_${C02.chargeIds[1]}`]: "confirmed",
    });
    // Run 1's effects were adopted, not sent again: only c01's two refunds are new.
    expect(exec.operational.refunds.length).toBe(sentBefore.refunds + 2);
    expect(exec.operational.refunds.map((r) => r.charge).sort()).toEqual(
      [C01.chargeIds[1], PHANTOM, C02.chargeIds[1]].sort(),
    );
    expect(exec.operational.tickets.get(String(C02.ticketId))?.comments.length).toBe(
      sentBefore.comments,
    );
    expect(exec.operational.tickets.get(String(C01.ticketId))?.comments).toHaveLength(2);
    const adopted = run2.receipts.find((r) => r.actionId === `patch_${C01.ticketId}`);
    expect(adopted?.limitations.join(" ")).toMatch(/not re-sent/);
  });

  it("refuses a repair that changes a kept step or reaches outside the open cases", async () => {
    const planning = world();
    await planCase(planning.session, C01);
    await planCase(planning.session, C02);
    const r1 = planning.session.manifest(META);
    const scope = {
      kept: r1.actions.filter((a) => a.caseId !== `case_${C01.customerId}`).map((a) => a.id),
      openCases: [`case_${C01.customerId}`],
    };
    const changed = structuredClone({ ...r1, revision: 2, parentRevision: 1 });
    const kept = changed.actions.find((a) => a.id === `refund_${C02.chargeIds[1]}`);
    if (kept) kept.rationale = "edited";
    expect(checkRepair(r1, scope, changed)).toContain(
      `kept step refund_${C02.chargeIds[1]} changed or is missing`,
    );
    const outside = structuredClone({ ...r1, revision: 2, parentRevision: 1 });
    outside.actions = outside.actions.filter((a) => !scope.kept.includes(a.id) || a.caseId !== "x");
    const extra = structuredClone(
      outside.actions.find((a) => a.id === `refund_${C01.chargeIds[1]}`),
    );
    if (!extra) throw new Error("no refund");
    outside.actions.push({ ...extra, id: "refund_elsewhere", caseId: "case_cus_other" });
    expect(checkRepair(r1, scope, outside)).toContain(
      "refund_elsewhere is outside the repaired cases",
    );
    expect(checkRepair(r1, scope, { ...r1 })).toContain("a repair of revision 1 is revision 2");
  });
});
