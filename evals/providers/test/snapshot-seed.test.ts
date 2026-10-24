import { randomBytes } from "node:crypto";
import type { Observation, PlanManifest, QueryObservation } from "@rehearsal/contracts";
import { fingerprint } from "@rehearsal/core";
import {
  eraAdmin,
  STRIPE_CHARGE_PROJECTION,
  stripeChargeProjection,
  stripeReader,
  type WorldConfig,
  ZENDESK_TICKET_PROJECTION,
  zendeskReader,
  zendeskTicketProjection,
} from "@rehearsal/providers";
import {
  billingManifest,
  happyPathBundle,
  INCIDENT,
  incidentRecords,
  type SeededCase,
} from "@rehearsal/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedIncident } from "../../../scripts/seed/incident";
import {
  provisionSnapshot,
  type RehearsalWorlds,
  rehearsalAdminToken,
  rehearsalWorldConfig,
  supportSnapshot,
  teardownSnapshot,
  verifySnapshot,
} from "../../../scripts/seed/snapshot";
import {
  adminToken,
  type EraVendor,
  getJson,
  REHEARSAL_ENABLED,
  resetScratchTenants,
  resetTenant,
  scratchWorld,
  stripePost,
  uniqueTenant,
} from "../src/harness";

const records = incidentRecords();
/** One duplicate case (c01, 42.10 CAD): refund the second charge, patch and note the ticket. */
const CASE = cohortCase("c01");

function cohortCase(key: string): SeededCase {
  const c = records.cases.find((item) => item.key === key);
  if (!c) throw new Error(`cohort has no case ${key}`);
  return c;
}

type Evidence = Pick<PlanManifest, "actions" | "observations" | "queryObservations">;

/** The fixture plan's case_001 steps, pointed at the evidence given. */
function plan(observations: Observation[], queryObservations: QueryObservation[]): Evidence {
  const charge = observations.find((o) => o.entity.kind === "charge");
  const ticket = observations.find((o) => o.entity.kind === "ticket");
  const query = queryObservations.find((q) => q.vendor === "stripe");
  if (!charge || !ticket || !query) throw new Error("incomplete evidence");
  const actions = billingManifest("plan_snapshot")
    .actions.filter((a) => a.caseId === "case_001")
    .map((a) => {
      const copy = structuredClone(a);
      if (copy.kind === "stripe.refund.create") {
        copy.args.chargeId = charge.entity.id;
        copy.evidence = [charge.id];
        copy.queryEvidence = [query.id];
      } else {
        copy.args.ticketId = ticket.entity.id;
        copy.evidence = [ticket.id];
        copy.queryEvidence = [];
      }
      return copy;
    });
  return { observations, queryObservations, actions };
}

/** Planning evidence as the readers would capture it from the seeded cohort, built offline. */
function offlineEvidence(): Evidence {
  const charges = records.stripe.charges.filter((c) => c.customer === CASE.customerId);
  const ticket = records.zendesk.tickets.find((t) => t.id === CASE.ticketId) ?? {};
  const obs = (
    id: string,
    kind: "charge" | "ticket",
    projection: Record<string, unknown>,
  ): Observation => ({
    id,
    world: "planning",
    entity: { vendor: kind === "charge" ? "stripe" : "zendesk", kind, id: String(projection.id) },
    projectionVersion: kind === "charge" ? STRIPE_CHARGE_PROJECTION : ZENDESK_TICKET_PROJECTION,
    projection,
    fingerprint: fingerprint(projection),
    capturedAt: "2026-10-24T00:00:00.000Z",
  });
  const projections = Object.fromEntries(
    charges.map((c) => [String(c.id), stripeChargeProjection(c)]),
  );
  const matchingIds = Object.keys(projections).sort();
  return plan(
    [
      obs("obs_charge", "charge", stripeChargeProjection(charges[1] ?? {})),
      obs("obs_ticket", "ticket", zendeskTicketProjection(ticket)),
    ],
    [
      {
        id: "q_charges",
        world: "planning",
        vendor: "stripe",
        predicate: {
          kind: "stripe.charges.byCustomerInWindow",
          customerId: CASE.customerId,
          ...INCIDENT.window,
        },
        cutoff: "2026-10-24T00:00:00.000Z",
        complete: true,
        matchingIds,
        projectionVersion: STRIPE_CHARGE_PROJECTION,
        projections,
        fingerprint: fingerprint({ matchingIds, projections }),
        capturedAt: "2026-10-24T00:00:00.000Z",
      },
    ],
  );
}

const ENV = {
  ERA_ADMIN_TOKEN: "operational-admin",
  REHEARSAL_ERA_ADMIN_TOKEN: "rehearsal-admin",
  ERA_STRIPE_PLANNING_URL: "http://127.0.0.1:8101",
  ERA_STRIPE_OPERATIONAL_URL: "http://127.0.0.1:8102",
  ERA_ZENDESK_PLANNING_URL: "http://127.0.0.1:8111",
  ERA_ZENDESK_OPERATIONAL_URL: "http://127.0.0.1:8112",
  ERA_STRIPE_REHEARSAL_URL: "http://127.0.0.1:8103",
  ERA_ZENDESK_REHEARSAL_URL: "http://127.0.0.1:8113/",
};

// T1.22: what a snapshot must contain before any world is touched.
describe("snapshot support", () => {
  it("seeds exactly what the plan read, and lists the fixture defaults", () => {
    const support = supportSnapshot(offlineEvidence());
    if (!support.ok) throw new Error(support.refusals.join("; "));
    const { seed } = support;
    expect(seed.stripe.charges.map((c) => c.id).sort()).toEqual(CASE.chargeIds);
    for (const c of seed.stripe.charges) {
      const seeded = records.stripe.charges.find((r) => r.id === c.id) ?? {};
      expect(stripeChargeProjection(c)).toEqual(stripeChargeProjection(seeded));
      expect(c.payment_intent).toBe(`pi_${String(c.id).slice(3)}`);
    }
    expect(seed.zendesk.tickets).toHaveLength(1);
    expect(zendeskTicketProjection(seed.zendesk.tickets[0] ?? {})).toEqual(
      zendeskTicketProjection(records.zendesk.tickets.find((t) => t.id === CASE.ticketId) ?? {}),
    );
    expect(seed.notFromEvidence).toContain("stripe.charge.payment_method");
    expect(seed.notFromEvidence).toContain("zendesk.ticket.tags");
    for (const field of ["amount", "created", "subject", "requester_id", "payment_intent"]) {
      expect(seed.notFromEvidence.some((f) => f.endsWith(`.${field}`))).toBe(false);
    }
  });

  it("refuses an old projection that leaves out fields the simulator needs", () => {
    const support = supportSnapshot(happyPathBundle().manifest);
    expect(support.ok).toBe(false);
    if (support.ok) return;
    expect(support.refusals).toContain(
      "obs_charge_001: stripe.charge.v1 leaves out fields the simulator needs (stripe.charge.v2 has them)",
    );
    expect(support.refusals.some((r) => r.startsWith("q_charges_001:"))).toBe(true);
  });

  it("refuses incomplete, operational, unobserved, conflicting or dangling evidence", () => {
    const refusals = (change: (e: Evidence) => void) => {
      const evidence = offlineEvidence();
      change(evidence);
      const support = supportSnapshot(evidence);
      return support.ok ? [] : support.refusals;
    };
    expect(
      refusals((e) => {
        (e.queryObservations[0] as { complete: boolean }).complete = false;
      }),
    ).toEqual(["q_charges is incomplete: a partial enumeration can't be rebuilt"]);
    expect(
      refusals((e) => {
        (e.observations[0] as { world: string }).world = "operational";
      }),
    ).toContain("obs_charge was read in the operational world, not the planning world");
    expect(
      refusals((e) => {
        for (const a of e.actions) if (a.kind !== "stripe.refund.create") a.evidence = [];
      }),
    ).toEqual([
      `patch_001 writes zendesk ticket ${CASE.ticketId} unobserved`,
      `note_001 writes zendesk ticket ${CASE.ticketId} unobserved`,
    ]);
    expect(
      refusals((e) => {
        (e.observations[0]?.projection as { amount_refunded: number }).amount_refunded = 100;
      }),
    ).toEqual([
      `obs_charge and q_charges[${CASE.chargeIds[1]}] disagree about ${CASE.chargeIds[1]}`,
    ]);
    expect(
      refusals((e) => {
        e.actions[0]?.queryEvidence.push("q_missing");
      }),
    ).toEqual(["refund_001 cites q_missing, which the plan lacks"]);
    expect(
      refusals((e) => {
        (e.observations[1]?.projection as { requester_id: string }).requester_id = "cus_1";
      }),
    ).toEqual(["obs_ticket: requester_id"]);
  });

  it("binds a rehearsal only to its own tenant in the rehearsal containers", () => {
    expect(rehearsalWorldConfig("zendesk", "abcd1234", ENV)).toEqual({
      baseUrl: "http://127.0.0.1:8113",
      tenant: "rh-abcd1234",
    });
    expect(() => rehearsalWorldConfig("stripe", "Demo", ENV)).toThrow();
    expect(() =>
      rehearsalWorldConfig("stripe", "abcd1234", {
        ...ENV,
        ERA_STRIPE_REHEARSAL_URL: "http://localhost:8102",
      }),
    ).toThrow("ERA_STRIPE_REHEARSAL_URL is ERA_STRIPE_OPERATIONAL_URL's world");
    expect(() =>
      rehearsalAdminToken({ ...ENV, REHEARSAL_ERA_ADMIN_TOKEN: ENV.ERA_ADMIN_TOKEN }),
    ).toThrow("must differ");
  });

  it("tears down only a finished rehearsal", async () => {
    for (const state of ["queued", "provisioning", "running", "verifying"] as const) {
      await expect(teardownSnapshot("abcd1234", state, ENV)).rejects.toThrow("only a finished");
    }
  });
});

const rehearsalId = () => `t122${randomBytes(4).toString("hex")}`;

// Raw records of a world's tenant, to show a rehearsal never changed it.
async function contents(vendor: EraVendor, world: WorldConfig): Promise<unknown> {
  return vendor === "stripe"
    ? getJson(vendor, world, "/v1/charges?limit=100")
    : getJson(vendor, world, "/api/v2/tickets.json?per_page=100");
}

// T1.22 on Era: seed from captured planning evidence, read back, isolate, tear down.
describe.skipIf(!REHEARSAL_ENABLED)("snapshot seed on the rehearsal worlds", () => {
  const tenant = uniqueTenant("snapshot");
  const planning = {} as Record<EraVendor, WorldConfig>;
  const operational = {} as Record<EraVendor, WorldConfig>;
  const ids = [rehearsalId(), rehearsalId()] as const;
  const provisioned: RehearsalWorlds[] = [];
  let evidence: Evidence;
  let before: unknown;

  beforeAll(async () => {
    for (const vendor of ["stripe", "zendesk"] as const) {
      planning[vendor] = await scratchWorld(vendor, "planning", tenant);
      operational[vendor] = await scratchWorld(vendor, "operational", tenant);
      for (const world of [planning[vendor], operational[vendor]]) {
        await resetTenant(world);
        await seedIncident(vendor, world);
      }
    }
    const ctx = { world: "planning", tenant } as const;
    const stripe = stripeReader({
      world: "planning",
      config: planning.stripe,
      authorization: "Bearer sk_test_snapshot",
    });
    const zendesk = zendeskReader({
      world: "planning",
      config: planning.zendesk,
      authorization: "Bearer snapshot",
    });
    const charge = await stripe.observe(
      { vendor: "stripe", kind: "charge", id: CASE.chargeIds[1] },
      ctx,
    );
    const ticket = await zendesk.observe(
      { vendor: "zendesk", kind: "ticket", id: String(CASE.ticketId) },
      ctx,
    );
    const charges = await stripe.query(
      {
        kind: "stripe.charges.byCustomerInWindow",
        customerId: CASE.customerId,
        ...INCIDENT.window,
      },
      new Date().toISOString(),
      ctx,
    );
    const tickets = await zendesk.query(
      { kind: "zendesk.tickets.byRequester", requesterId: String(CASE.requesterId) },
      new Date().toISOString(),
      ctx,
    );
    evidence = plan([charge, ticket], [charges, tickets]);
    before = await Promise.all(
      (["stripe", "zendesk"] as const).flatMap((v) => [
        contents(v, planning[v]),
        contents(v, operational[v]),
      ]),
    );
    for (const id of ids) {
      const result = await provisionSnapshot(evidence, id);
      if (!result.ok) throw new Error(result.refusals.join("; "));
      provisioned.push(result.worlds);
    }
  });

  afterAll(async () => {
    for (const id of ids) await teardownSnapshot(id, "cancelled");
    await resetScratchTenants();
  });

  it("captures the same evidence the offline builder assumes", () => {
    const offline = offlineEvidence();
    expect(evidence.observations.map((o) => o.projection)).toEqual(
      offline.observations.map((o) => o.projection),
    );
    expect(evidence.queryObservations[0]?.projections).toEqual(
      offline.queryObservations[0]?.projections,
    );
  });

  it("reads back exactly the plan's evidence in a fresh rh- tenant", async () => {
    expect(provisioned[0]?.stripe?.tenant).toBe(`rh-${ids[0]}`);
    expect(provisioned[0]?.stripe?.baseUrl).toBe(process.env.ERA_STRIPE_REHEARSAL_URL);
    for (const worlds of provisioned) {
      expect(await verifySnapshot(evidence, worlds)).toEqual({ ok: true, mismatches: [] });
    }
  });

  it("keeps two rehearsals apart, and a changed record refuses the run", async () => {
    const [a, b] = provisioned;
    if (!a?.stripe || !b) throw new Error("not provisioned");
    const res = await stripePost(a.stripe, "/v1/refunds", `charge=${CASE.chargeIds[1]}&amount=100`);
    expect(res.ok).toBe(true);
    const verdict = await verifySnapshot(evidence, a);
    expect(verdict.ok).toBe(false);
    expect(verdict.mismatches).toContain(`${evidence.observations[0]?.id}: amount_refunded differ`);
    expect(await verifySnapshot(evidence, b)).toEqual({ ok: true, mismatches: [] });
  });

  it("leaves the planning and operational worlds as they were", async () => {
    const after = await Promise.all(
      (["stripe", "zendesk"] as const).flatMap((v) => [
        contents(v, planning[v]),
        contents(v, operational[v]),
      ]),
    );
    expect(after).toEqual(before);
  });

  it("holds an admin token that can't reach a shared world, and isn't reachable by its token", async () => {
    // A scratch operational tenant, so even a wrongly accepted reset would harm nothing.
    expect((await eraAdmin(operational.stripe, rehearsalAdminToken(), "/reset")).status).toBe(403);
    const rehearsal = provisioned[1]?.stripe;
    if (!rehearsal) throw new Error("not provisioned");
    expect((await eraAdmin(rehearsal, adminToken(), "/reset")).status).toBe(403);
    expect(await verifySnapshot(evidence, provisioned[1] ?? {})).toEqual({
      ok: true,
      mismatches: [],
    });
  });

  it("tears a finished rehearsal down, idempotently", async () => {
    const [id] = ids;
    const reset = await teardownSnapshot(id, "completed");
    expect(reset).toEqual([`stripe/rh-${id}`, `zendesk/rh-${id}`]);
    expect(await teardownSnapshot(id, "completed")).toEqual(reset);
    const verdict = await verifySnapshot(evidence, provisioned[0] ?? {});
    expect(verdict.mismatches).toContain(
      `${evidence.observations[0]?.id}: GET /v1/charges/${CASE.chargeIds[1]} → 404`,
    );
  });
});
