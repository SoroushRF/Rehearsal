import type Anthropic from "@anthropic-ai/sdk";
import type { PlanManifest } from "@rehearsal/contracts";
import { type BillingPolicyV1, fingerprint } from "@rehearsal/core";
import type { MessagesClient, PlanningReader } from "@rehearsal/planner";
import {
  type ClaimedPlanJob,
  type CompletePlanJob,
  type FailPlanJob,
  type PlannerJobsClient,
  STRIPE_CHARGE_PROJECTION,
  stripeChargeProjection,
  ZENDESK_TICKET_PROJECTION,
} from "@rehearsal/providers";
import { INCIDENT, incidentRecords } from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import policy from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import { handlePlanJob, type PlanJobContext } from "../src/job";

const MODEL = "claude-sonnet-5-5";
const records = incidentRecords();
const duplicate = records.cases.find((c) => c.kind === "duplicate");
if (!duplicate) throw new Error("no duplicate case");

const JOB: ClaimedPlanJob = {
  id: "7a1d3c52-8a0e-4b8e-9d55-0f3f5b8a2e11",
  data: {
    orgId: "org_demo",
    incidentId: INCIDENT.incident,
    planId: "plan_job_test",
    requestedBy: "user_r",
  },
};

/** Planning-world Stripe reads over the seeded charges; Zendesk is never touched here. */
const stripe: PlanningReader = {
  vendor: "stripe",
  async observe(entity) {
    const c = records.stripe.charges.find((x) => String(x.id) === entity.id);
    if (!c) throw new Error("404");
    const projection = stripeChargeProjection(c);
    return {
      id: `obs_${entity.id}`,
      world: "planning",
      entity,
      projectionVersion: STRIPE_CHARGE_PROJECTION,
      projection,
      fingerprint: fingerprint(projection),
      capturedAt: new Date().toISOString(),
    };
  },
  async query(predicate, cutoff) {
    if (predicate.kind !== "stripe.charges.byCustomerInWindow") throw new Error("unsupported");
    const hits = records.stripe.charges.filter((c) => c.customer === predicate.customerId);
    const projections = Object.fromEntries(
      hits.map((c) => [String(c.id), stripeChargeProjection(c)]),
    );
    const matchingIds = Object.keys(projections).sort();
    return {
      id: "q_test",
      world: "planning",
      vendor: "stripe",
      predicate,
      cutoff,
      complete: true,
      matchingIds,
      projectionVersion: STRIPE_CHARGE_PROJECTION,
      projections,
      fingerprint: fingerprint({ matchingIds, projections }),
      capturedAt: new Date().toISOString(),
    };
  },
};
const zendesk: PlanningReader = {
  vendor: "zendesk",
  observe: async () => {
    throw new Error("not used");
  },
  query: async () => {
    throw new Error("not used");
  },
};

function reply(calls: [string, unknown][], extra: Partial<Anthropic.Message> = {}) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: MODEL,
    content: [
      ...(calls.length === 0 ? [{ type: "text", text: "Refunded one duplicate." }] : []),
      ...calls.map(([name, input], i) => ({ type: "tool_use", id: `tu_${i}`, name, input })),
    ],
    stop_reason: calls.length > 0 ? "tool_use" : "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...extra,
  } as unknown as Anthropic.Message;
}

function model(turns: (Anthropic.Message | Error)[]): MessagesClient {
  let n = 0;
  return {
    async create() {
      const next = turns[n++];
      if (!next) throw new Error("script ran out");
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

function fakeJobs() {
  const completed: [string, CompletePlanJob][] = [];
  const failed: [string, FailPlanJob][] = [];
  const jobs: PlannerJobsClient = {
    next: async () => null,
    complete: async (id, body) => {
      completed.push([id, body]);
      return { planHash: "sha256:stored" };
    },
    fail: async (id, body) => {
      failed.push([id, body]);
    },
  };
  return { jobs, completed, failed };
}

function deps(client: MessagesClient, jobs: PlannerJobsClient): PlanJobContext {
  return {
    jobs,
    client,
    model: MODEL,
    readers: { stripe, zendesk },
    ctx: { world: "planning", tenant: "rehearsal-demo" },
    policy: policy as BillingPolicyV1,
    adapters: { stripe: STRIPE_CHARGE_PROJECTION, zendesk: ZENDESK_TICKET_PROJECTION },
  };
}

describe("plan job", () => {
  it("plans in the planning world and hands revision 1 to the API", async () => {
    const { jobs, completed, failed } = fakeJobs();
    const client = model([
      reply([["list_customer_charges", { customerId: duplicate.customerId }]]),
      reply([
        [
          "propose_duplicate_refund",
          {
            chargeId: duplicate.chargeIds[1],
            duplicateOfChargeId: duplicate.chargeIds[0],
            rationale: "Charged twice for one invoice.",
          },
        ],
      ]),
      reply([]),
    ]);
    const result = await handlePlanJob(JOB, deps(client, jobs));

    expect(result).toEqual({ kind: "stored", planId: JOB.data.planId, planHash: "sha256:stored" });
    expect(failed).toEqual([]);
    const [id, body] = completed[0] ?? [];
    expect(id).toBe(JOB.id);
    expect(body?.manifest).toMatchObject({
      orgId: JOB.data.orgId,
      planId: JOB.data.planId,
      incidentId: INCIDENT.incident,
      revision: 1,
    });
    expect((body?.manifest as PlanManifest | undefined)?.actions).toHaveLength(1);
    expect(body?.summary).toBe("Refunded one duplicate.");
    expect(body?.stats).toMatchObject({ turns: 3, toolCalls: 2 });
  });

  it("reports a loop failure on the job with its reason", async () => {
    const { jobs, completed, failed } = fakeJobs();
    const client = model([reply([], { stop_reason: "refusal" })]);
    const result = await handlePlanJob(JOB, deps(client, jobs));
    expect(result).toMatchObject({ kind: "failed", reason: "refusal" });
    expect(completed).toEqual([]);
    expect(failed.map(([id, b]) => [id, b.reason])).toEqual([[JOB.id, "refusal"]]);
  });

  it("reports a model or network error instead of leaving the job to expire", async () => {
    const { jobs, failed } = fakeJobs();
    const result = await handlePlanJob(JOB, deps(model([new Error("overloaded")]), jobs));
    expect(result).toMatchObject({ kind: "failed", reason: "planner_error" });
    expect(failed[0]?.[1].message).toBe("overloaded");
  });

  it("refuses an incident it has no brief for, without calling the model", async () => {
    const { jobs, failed } = fakeJobs();
    const job = { ...JOB, data: { ...JOB.data, incidentId: "INC-OTHER" } };
    const result = await handlePlanJob(job, deps(model([]), jobs));
    expect(result).toMatchObject({ kind: "failed", reason: "unknown_incident" });
    expect(failed).toHaveLength(1);
  });
});
