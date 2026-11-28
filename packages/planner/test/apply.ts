import type { PlanManifest } from "@rehearsal/contracts";
import {
  type BillingPolicyV1,
  createReadGuard,
  type ExecutorDeps,
  executeRun,
  fingerprint,
  type ProviderPort,
  planHash,
} from "@rehearsal/core";
import {
  STRIPE_CHARGE_PROJECTION,
  stripeChargeProjection,
  ZENDESK_TICKET_PROJECTION,
  zendeskTicketProjection,
} from "@rehearsal/providers";
import {
  approvedGrant,
  FakeClock,
  fakeRunAdmit,
  MemoryApplyStore,
  MemoryJournal,
  worldFromManifest,
} from "@rehearsal/testkit";
import policyV1 from "../../../scenarios/billing/policy.v1.json" with { type: "json" };

/**
 * The real executor and its read guard over a fake operational world built from a plan's own
 * evidence: what apply would do, with only the world in memory. Each `apply` stores the revision
 * with its own approval and run.
 */
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

export function executor(r1: PlanManifest) {
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
