import type { Observation, PlanManifest, QueryObservation } from "@rehearsal/contracts";
import {
  type BillingPolicyV1,
  createCompensator,
  createReadGuard,
  type DispatchResult,
  executeRun,
  type ProviderPort,
  planHash,
} from "@rehearsal/core";
import {
  stripeReader,
  stripeWriter,
  type WorldConfig,
  withWriter,
  zendeskReader,
  zendeskWriter,
} from "@rehearsal/providers";
import {
  billingManifest,
  FakeClock,
  fakeRunAdmit,
  INCIDENT,
  incidentRecords,
  MemoryApplyStore,
  MemoryJournal,
  type SeededCase,
  teammateConflictBundle,
} from "@rehearsal/testkit";
import { afterAll, describe, expect, it } from "vitest";
import policy from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import { seedIncident } from "../../../scripts/seed/incident";
import {
  ENABLED,
  type EraVendor,
  getJson,
  getTicket,
  resetScratchTenants,
  resetTenant,
  scratchWorld,
  uniqueTenant,
  zendeskPutTicket,
} from "../src/harness";

const records = incidentRecords();
const cohortCase = (key: string): SeededCase => {
  const c = records.cases.find((item) => item.key === key);
  if (!c) throw new Error(`cohort has no case ${key}`);
  return c;
};
/** The fixture plan's two cases match cohort c01 and c02; c02's ticket is the demo's conflict. */
const CASES: Record<"001" | "002", SeededCase> = {
  "001": cohortCase("c01"),
  "002": cohortCase("c02"),
};
const C02_TICKET = CASES["002"].ticketId;

type Worlds = Record<EraVendor, { planning: WorldConfig; operational: WorldConfig }>;

/** A scratch tenant seeded with the cohort, and a plan built from its planning-world reads. */
async function cohortPlan(
  label: string,
): Promise<{ tenant: string; worlds: Worlds; manifest: PlanManifest }> {
  const tenant = uniqueTenant(label);
  const worlds = {} as Worlds;
  for (const vendor of ["stripe", "zendesk"] as const) {
    worlds[vendor] = {
      planning: await scratchWorld(vendor, "planning", tenant),
      operational: await scratchWorld(vendor, "operational", tenant),
    };
    for (const world of ["planning", "operational"] as const) {
      await resetTenant(worlds[vendor][world]);
      await seedIncident(vendor, worlds[vendor][world]);
    }
  }
  const ctx = { world: "planning", tenant } as const;
  const auth = { stripe: "Bearer sk_test_comp", zendesk: "Bearer comp" };
  const stripe = stripeReader({
    world: "planning",
    config: worlds.stripe.planning,
    authorization: auth.stripe,
  });
  const zendesk = zendeskReader({
    world: "planning",
    config: worlds.zendesk.planning,
    authorization: auth.zendesk,
  });
  const observations: Observation[] = [];
  const queryObservations: QueryObservation[] = [];
  for (const [n, c] of Object.entries(CASES)) {
    const charge = await stripe.observe(
      { vendor: "stripe", kind: "charge", id: c.chargeIds[1] },
      ctx,
    );
    const ticket = await zendesk.observe(
      { vendor: "zendesk", kind: "ticket", id: String(c.ticketId) },
      ctx,
    );
    const query = await stripe.query(
      { kind: "stripe.charges.byCustomerInWindow", customerId: c.customerId, ...INCIDENT.window },
      new Date().toISOString(),
      ctx,
    );
    observations.push({ ...charge, id: `obs_charge_${n}` }, { ...ticket, id: `obs_ticket_${n}` });
    queryObservations.push({ ...query, id: `q_charges_${n}` });
  }
  const base = billingManifest(`plan_comp_${tenant}`);
  const manifest: PlanManifest = {
    ...base,
    observations,
    queryObservations,
    actions: base.actions.map((a) => {
      const copy = structuredClone(a);
      const c = CASES[a.caseId.slice(-3) as "001" | "002"];
      if (copy.kind === "stripe.refund.create") copy.args.chargeId = c.chargeIds[1];
      else if ("ticketId" in copy.args) copy.args.ticketId = String(c.ticketId);
      return copy;
    }),
  };
  return { tenant, worlds, manifest };
}

/**
 * Apply the plan to the operational world with guard and compensation. c02's note is refused in
 * the harness (the bundle's `fail_step`; Era's faults only give 429s and 5xx); `afterFail` runs
 * right after that refusal, before compensation re-reads the ticket.
 */
async function apply(
  { tenant, worlds, manifest }: Awaited<ReturnType<typeof cohortPlan>>,
  afterFail: () => Promise<void> = async () => {},
) {
  const hash = planHash(manifest);
  const store = new MemoryApplyStore();
  store.runs.set("run_comp", {
    planId: manifest.planId,
    revision: 1,
    planHash: hash,
    approvalId: "g",
  });
  store.plans.set(`${manifest.planId}@1`, { planHash: hash, manifest });
  store.grants.set("g", {
    id: "g",
    orgId: manifest.orgId,
    planId: manifest.planId,
    revision: 1,
    planHash: hash,
    actorUserId: "user_finance",
    actorSessionId: "sess",
    roles: ["support_lead", "finance_lead"],
    permissions: ["rehearsal:approve:support_step", "rehearsal:approve:finance_step"],
    authzRule: { id: "rehearsal-authz", version: 1 },
    grantedAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    revokedAt: null,
  });
  const clock = new FakeClock("2026-10-21T12:00:00.000Z");
  const op = (vendor: EraVendor) => ({
    world: "operational" as const,
    config: worlds[vendor].operational,
    authorization: vendor === "stripe" ? "Bearer sk_test_comp" : "Bearer comp",
  });
  const providers: Record<EraVendor, ProviderPort> = {
    stripe: withWriter(stripeReader(op("stripe")), stripeWriter(op("stripe"))),
    zendesk: withWriter(zendeskReader(op("zendesk")), zendeskWriter(op("zendesk"))),
  };
  const dispatch = providers.zendesk.dispatch;
  const sent: string[] = [];
  providers.zendesk.dispatch = async (request, ctx): Promise<DispatchResult> => {
    const note =
      request.path === `/api/v2/tickets/${C02_TICKET}.json` &&
      request.body.includes('"comment"') &&
      !request.body.includes('"safe_update"');
    if (note) {
      await afterFail();
      return {
        kind: "rejected",
        status: 422,
        body: { error: "fail_step note_002" },
        retryable: false,
      };
    }
    sent.push(request.body);
    return dispatch(request, ctx);
  };
  const operational = {
    stripe: { world: "operational", tenant },
    zendesk: { world: "operational", tenant },
  } as const;
  let n = 0;
  const result = await executeRun(
    {
      orgId: manifest.orgId,
      runId: "run_comp",
      planId: manifest.planId,
      revision: 1,
      planHash: hash,
    },
    {
      store,
      journal: new MemoryJournal(),
      clock,
      providers,
      worlds: operational,
      policies: [policy as BillingPolicyV1],
      admit: fakeRunAdmit({ now: () => new Date("2026-10-22T12:00:00.000Z") }),
      newId: (p) => `${p}_${++n}`,
      guard: createReadGuard({ providers, worlds: operational, clock }),
      compensate: createCompensator({ providers, worlds: operational, clock }),
    },
  );
  return { result, sent };
}

const outcomes = (receipts: { actionId: string; outcome: string }[]) =>
  Object.fromEntries(receipts.map((r) => [r.actionId, r.outcome]));

const refundsOn = async (world: WorldConfig, chargeId: string) =>
  (await getJson<{ data: unknown[] }>("stripe", world, `/v1/refunds?charge=${chargeId}&limit=100`))
    .data.length;

/**
 * T4.4 gate: compensation on real Era. c02's priority patch is applied, its note then fails, and
 * compensation re-reads the ticket. Untouched, our value is reverted with a stamp-guarded patch.
 * After a teammate's edit (through the ordinary vendor API, like `demo:conflict`), it is kept.
 * The lost-undo read (marker present, stamp unchanged, fresh undo) is fixture evidence only.
 * This gate does not drop an undo response, so it does not exercise that read.
 */
describe.skipIf(!ENABLED)("conditional compensation on Era", () => {
  afterAll(resetScratchTenants);

  it("passes the teammate-conflict bundle: the teammate's priority survives", async () => {
    const plan = await cohortPlan("conflict");
    const ticket = plan.worlds.zendesk.operational;
    let edited = "";
    const { result, sent } = await apply(plan, async () => {
      const res = await zendeskPutTicket(ticket, C02_TICKET, { priority: "urgent" });
      expect(res.ok).toBe(true);
      edited = (await getTicket(ticket, C02_TICKET)).updated_at;
    });

    expect(result.error).toBeNull();
    expect(outcomes(result.receipts)).toEqual(
      Object.fromEntries(teammateConflictBundle().expected.map((e) => [e.actionId, e.outcome])),
    );
    expect(result.receipts.at(-1)).toMatchObject({
      actionId: "patch_002",
      outcome: "compensation_conflict",
      observedEffect: { priority: "urgent" },
    });
    // Nothing was written after the teammate's edit, and the refund stands.
    const after = await getTicket(ticket, C02_TICKET);
    expect(after.priority).toBe("urgent");
    expect(after.updated_at).toBe(edited);
    expect(sent.filter((b) => b.includes('"priority"'))).toHaveLength(2);
    expect(await refundsOn(plan.worlds.stripe.operational, CASES["002"].chargeIds[1])).toBe(1);
  });

  it("reverts our priority when nobody touched it, and keeps the refund", async () => {
    const plan = await cohortPlan("compensate");
    const ticket = plan.worlds.zendesk.operational;
    const before = (await getTicket(ticket, C02_TICKET)).priority;
    const { result, sent } = await apply(plan);

    expect(result.error).toBeNull();
    expect(outcomes(result.receipts)).toMatchObject({
      refund_002: "confirmed",
      patch_002: "compensated",
      note_002: "rejected",
      patch_001: "confirmed",
      note_001: "confirmed",
    });
    expect((await getTicket(ticket, C02_TICKET)).priority).toBe(before);
    expect((await getTicket(ticket, CASES["001"].ticketId)).priority).toBe("high");
    expect(JSON.parse(sent.at(-1) ?? "{}")).toMatchObject({
      ticket: { priority: before, safe_update: true },
    });
    expect(await refundsOn(plan.worlds.stripe.operational, CASES["002"].chargeIds[1])).toBe(1);
  });
});
