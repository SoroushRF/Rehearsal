import type { BillingPolicyV1 } from "@rehearsal/core";
import { PlanningSession, PROMPT_VERSION } from "@rehearsal/planner";
import { STRIPE_CHARGE_PROJECTION, ZENDESK_TICKET_PROJECTION } from "@rehearsal/providers";
import { INCIDENT, type SeededCase } from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import policyJson from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import { type DecidedIntent, runAgent } from "../src/agent";
import {
  describeModelPlan,
  meteredClient,
  RecordingSession,
  runModelAgent,
  scopedBrief,
} from "../src/model";
import { TASKS } from "../src/tasks";
import { type Call, planningWorld, reply, scriptedModel } from "./planning-world";

const MODEL = "gemini-test-model";
const policy = policyJson as BillingPolicyV1;
const CTX = { world: "planning", tenant: "sc-test" } as const;
const META = {
  orgId: "org_scorecard",
  incidentId: INCIDENT.incident,
  planId: "plan_scorecard_test",
  adapters: { stripe: STRIPE_CHARGE_PROJECTION, zendesk: ZENDESK_TICKET_PROJECTION },
};

const byId = (id: string) => {
  const task = TASKS.find((t) => t.id === id);
  if (!task) throw new Error(`no task ${id}`);
  return task;
};

function setup() {
  const { readers, records } = planningWorld();
  const cases = records.cases;
  const of = (key: string) => {
    const c = cases.find((x) => x.key === key);
    if (!c) throw new Error(`no case ${key}`);
    return c;
  };
  const opts = (client: Parameters<typeof runModelAgent>[2]["client"]) => ({
    client,
    model: MODEL,
    readers,
    ctx: CTX,
    policy,
    meta: META,
  });
  return { readers, cases, of, opts };
}

const refund = (c: SeededCase): Call => [
  "propose_duplicate_refund",
  {
    chargeId: c.chargeIds[1],
    duplicateOfChargeId: c.chargeIds[0],
    rationale: `${c.chargeIds[1]} repeats ${c.chargeIds[0]}.`,
  },
];
const priority = (c: SeededCase): Call => [
  "propose_ticket_priority",
  {
    customerId: c.customerId,
    ticketId: String(c.ticketId),
    priority: "high",
    rationale: "Billing error confirmed.",
  },
];
const note = (c: SeededCase): Call => [
  "propose_refund_note",
  { refundStepId: `refund_${c.chargeIds[1]}`, ticketId: String(c.ticketId) },
];

/** What a careful model does for these cases: read, refund the duplicates, patch and note them. */
function carefulScript(cases: readonly SeededCase[], extraRefunds: Call[] = []) {
  const dups = cases.filter((c) => c.kind === "duplicate");
  return [
    reply(
      MODEL,
      cases.map((c) => ["list_customer_charges", { customerId: c.customerId }]),
    ),
    reply(MODEL, [...dups.map(refund), ...extraRefunds]),
    reply(
      MODEL,
      dups.map((c) => ["list_requester_tickets", { requesterId: String(c.requesterId) }]),
    ),
    reply(
      MODEL,
      dups.flatMap((c) => [priority(c), note(c)]),
    ),
    reply(MODEL, []),
  ];
}

/** What the modes compare: the write and its facts, not the rationale wording. */
const facts = (decided: readonly DecidedIntent[]) =>
  decided
    .map(({ intent, accepted }) => {
      const { rationale: _, ...input } = intent.input as Record<string, unknown>;
      const { input: __, ...rest } = intent;
      return JSON.stringify({ ...rest, input, accepted });
    })
    .sort();

describe("scoped brief", () => {
  it("asks the model about the task's customers only", () => {
    const { cases, of } = setup();
    expect(scopedBrief(byId("B2"), cases).customers.map((c) => c.customerId)).toEqual([
      of("c03").customerId,
    ]);
    const controls = scopedBrief(byId("B4"), cases).customers.map((c) => c.customerId);
    expect(controls.sort()).toEqual(
      cases
        .filter((c) => c.kind !== "duplicate")
        .map((c) => c.customerId)
        .sort(),
    );
    expect(scopedBrief(byId("B1"), cases).customers).toHaveLength(cases.length);
    expect(scopedBrief(byId("B1"), cases).window).toEqual(INCIDENT.window);
  });
});

describe("recording session", () => {
  it("keeps accepted and refused proposals with the facts direct mode needs", async () => {
    const { readers, cases, of } = setup();
    const session = new RecordingSession(
      { readers, ctx: CTX, policy, window: INCIDENT.window },
      cases,
    );
    const c03 = of("c03");
    const usd = cases.find((c) => c.kind === "control_other_currency");
    if (!usd) throw new Error("no usd control");
    expect((await session.call(...refund(c03))).ok).toBe(true);
    expect((await session.call(...refund(usd))).ok).toBe(false);
    expect((await session.call(...priority(c03))).ok).toBe(true);
    expect((await session.call(...note(c03))).ok).toBe(true);
    // A note on the refused refund: refused too, but direct mode sent that refund, so it follows.
    expect((await session.call(...note(usd))).ok).toBe(false);
    // A note for a refund the model never asked for: direct mode has no refund ID and skips it.
    const never = { refundStepId: "refund_ch_never", ticketId: String(c03.ticketId) };
    expect((await session.call("propose_refund_note", never)).ok).toBe(false);

    const [r, u, p, n, usdNote, orphan] = session.decided;
    expect(r).toMatchObject({
      accepted: true,
      intent: {
        caseKey: "c03",
        tool: "propose_duplicate_refund",
        amountMinor: c03.amountMinor,
        currency: "cad",
      },
    });
    expect(u).toMatchObject({
      accepted: false,
      intent: { caseKey: usd.key, amountMinor: usd.amountMinor, currency: usd.currency },
    });
    expect(u?.refusal).toMatch(/refunds only cad/);
    expect(p).toMatchObject({
      accepted: true,
      intent: { caseKey: "c03", before: { priority: "normal", status: "open" } },
    });
    expect(n).toMatchObject({
      accepted: true,
      intent: { caseKey: "c03", tool: "propose_refund_note", amountMinor: c03.amountMinor },
    });
    expect(usdNote).toMatchObject({
      accepted: false,
      intent: { caseKey: usd.key, tool: "propose_refund_note", amountMinor: usd.amountMinor },
    });
    // Its case comes from the ticket's external_id.
    expect(orphan).toMatchObject({
      accepted: false,
      intent: { caseKey: "c03", tool: "propose_refund_note", input: never, amountMinor: 0 },
    });
    expect(session.decided).toHaveLength(6);
    expect(session.actions.map((a) => a.id)).toEqual([
      `refund_${c03.chargeIds[1]}`,
      `patch_${c03.ticketId}`,
      `note_refund_${c03.chargeIds[1]}`,
    ]);
  });

  it("ignores reads and malformed calls, and reports writes it can't build", async () => {
    const { readers, cases, of } = setup();
    const session = new RecordingSession(
      { readers, ctx: CTX, policy, window: INCIDENT.window },
      cases,
    );
    const c01 = of("c01");
    await session.call("list_customer_charges", { customerId: c01.customerId });
    await session.call("get_charge", { chargeId: c01.chargeIds[0] });
    // Not a valid tool input: a malformed request, not a write.
    await session.call("propose_duplicate_refund", { chargeId: "not-a-charge" });
    await session.call("propose_duplicate_refund", {
      chargeId: c01.chargeIds[1],
      duplicateOfChargeId: c01.chargeIds[0],
      rationale: "x",
      url: "https://example.com",
    });
    await session.call("transfer_money", { to: "me" });
    expect(session.decided).toEqual([]);
    expect(session.unsendable).toEqual([]);

    // Valid shape, but the charge doesn't exist: refused by the tools, and nothing to send.
    const res = await session.call("propose_duplicate_refund", {
      chargeId: "ch_missing",
      duplicateOfChargeId: c01.chargeIds[0],
      rationale: "x",
    });
    expect(res.ok).toBe(false);
    expect(session.decided).toEqual([]);
    expect(session.unsendable).toHaveLength(1);
    expect(session.unsendable[0]).toMatch(/ch_missing.*404/);
  });

  it("keys a customer outside the cohort by its own ID", async () => {
    const { readers, of } = setup();
    // No cases known: every customer is outside the cohort.
    const session = new RecordingSession(
      { readers, ctx: CTX, policy, window: INCIDENT.window },
      [],
    );
    await session.call(...refund(of("c01")));
    expect(session.decided[0]?.intent.caseKey).toBe(of("c01").customerId);
  });
});

describe("metered client", () => {
  it("sums usage over every response", async () => {
    const { client, meter } = meteredClient(
      scriptedModel([reply(MODEL, []), reply(MODEL, [])]).client,
    );
    const params = { model: MODEL, max_tokens: 1, messages: [] };
    await client.create(params);
    await client.create(params);
    expect(meter).toEqual({
      calls: 2,
      usage: { inputTokens: 200, outputTokens: 100, cacheReadTokens: 160 },
    });
  });
});

describe("model planner", () => {
  it("plans with the bounded loop and records model, prompt version and tokens", async () => {
    const { cases, of, opts } = setup();
    const c03 = of("c03");
    const model = scriptedModel(carefulScript([c03]));
    const r = await runModelAgent(byId("B2"), cases, opts(model.client));

    expect(r.outcome).toEqual({ status: "planned" });
    expect(r.model).toBe(MODEL);
    expect(r.promptVersion).toBe(PROMPT_VERSION);
    expect(r.manifest.versions.planner).toMatchObject({
      model: MODEL,
      promptVersion: PROMPT_VERSION,
    });
    expect(r.manifest.planId).toBe(META.planId);
    expect(r.manifest.actions.map((a) => a.kind)).toEqual([
      "stripe.refund.create",
      "zendesk.ticket.patchFields",
      "zendesk.ticket.appendPrivateNote",
    ]);
    expect(r.turns).toBe(5);
    expect(r.toolCalls).toBe(5);
    expect(r.usage).toEqual({ inputTokens: 500, outputTokens: 250, cacheReadTokens: 400 });
    expect(r.summary).toBe("Done.");
    expect(r.intents.every((i) => i.accepted)).toBe(true);

    // The brief named c03 only, and the model saw the planning tools and nothing else.
    const first = model.requests[0];
    const brief = String(first?.messages[0]?.content);
    expect(brief).toContain(c03.customerId);
    for (const other of cases.filter((c) => c.key !== "c03")) {
      expect(brief).not.toContain(other.customerId);
    }
    expect(first?.model).toBe(MODEL);
    expect(first?.tools?.map((t) => (t as { name: string }).name).sort()).toEqual(
      [
        "get_charge",
        "get_ticket",
        "list_customer_charges",
        "list_requester_tickets",
        "propose_customer_reply",
        "propose_duplicate_refund",
        "propose_refund_note",
        "propose_run_summary",
        "propose_ticket_priority",
      ].sort(),
    );
    expect(describeModelPlan("B2", r)).toMatch(
      /^B2 +plan +3 steps, 0 refused, 5 turns, 5 tool calls, 500 in \+ 400 cached \/ 250 out$/,
    );
  });

  it("feeds the modes the same writes the scripted agent would make", async () => {
    const { readers, cases, opts } = setup();
    const task = byId("B1");
    const modelRun = await runModelAgent(
      task,
      cases,
      opts(scriptedModel(carefulScript(cases)).client),
    );
    const scripted = await runAgent(
      task,
      cases,
      new PlanningSession({ readers, ctx: CTX, policy, window: INCIDENT.window }),
      META,
    );
    expect(facts(modelRun.intents)).toEqual(facts(scripted.intents));
    expect(modelRun.manifest.actions.map((a) => a.id).sort()).toEqual(
      scripted.manifest.actions.map((a) => a.id).sort(),
    );
  });

  it("keeps a refused proposal for direct mode but out of the plan", async () => {
    const { cases, opts } = setup();
    const usd = cases.find((c) => c.kind === "control_other_currency");
    if (!usd) throw new Error("no usd control");
    const r = await runModelAgent(
      byId("B1"),
      cases,
      opts(scriptedModel(carefulScript(cases, [refund(usd)])).client),
    );
    expect(r.outcome.status).toBe("planned");
    const refused = r.intents.filter((i) => !i.accepted);
    expect(refused.map((i) => i.intent.caseKey)).toEqual([usd.key]);
    expect(r.manifest.actions.some((a) => a.caseId === `case_${usd.customerId}`)).toBe(false);
    expect(describeModelPlan("B1", r)).toContain("24 steps, 1 refused");
  });

  it("reports a finished run with no steps as empty, not failed", async () => {
    const { cases, opts } = setup();
    const controls = cases.filter((c) => c.kind !== "duplicate");
    const r = await runModelAgent(
      byId("B4"),
      cases,
      opts(
        scriptedModel([
          reply(
            MODEL,
            controls.map((c) => ["list_customer_charges", { customerId: c.customerId }]),
          ),
          reply(MODEL, []),
        ]).client,
      ),
    );
    expect(r.outcome).toEqual({ status: "empty" });
    expect(r.manifest.actions).toEqual([]);
    expect(r.manifest.versions.planner.model).toBe(MODEL);
    expect(r.intents).toEqual([]);
    expect(describeModelPlan("B4", r)).toContain("no steps proposed");
  });

  it("stores no plan when the model refuses, but keeps what it tried and what it cost", async () => {
    const { cases, of, opts } = setup();
    const c03 = of("c03");
    const r = await runModelAgent(
      byId("B2"),
      cases,
      opts(
        scriptedModel([
          reply(MODEL, [["list_customer_charges", { customerId: c03.customerId }]]),
          reply(MODEL, [refund(c03)]),
          reply(MODEL, [], { stop_reason: "refusal" }),
        ]).client,
      ),
    );
    expect(r.outcome).toMatchObject({ status: "failed", reason: "refusal" });
    // Rehearsal gets nothing to approve; direct and per-call still get the refund the model sent.
    expect(r.manifest.actions).toEqual([]);
    expect(r.intents).toHaveLength(1);
    expect(r.intents[0]).toMatchObject({ accepted: true, intent: { caseKey: "c03" } });
    expect(r.turns).toBe(3);
    expect(r.usage.inputTokens).toBe(300);
    expect(describeModelPlan("B2", r)).toContain("PLAN FAILED (refusal: model declined");
  });

  it("fails the plan on a loop limit or a substituted model", async () => {
    const { cases, of, opts } = setup();
    const c03 = of("c03");
    const read: Call = ["list_customer_charges", { customerId: c03.customerId }];
    const limited = await runModelAgent(byId("B2"), cases, {
      ...opts(scriptedModel([reply(MODEL, [read]), reply(MODEL, [read])]).client),
      limits: { maxTurns: 2 },
    });
    expect(limited.outcome).toMatchObject({ status: "failed", reason: "turn_limit" });

    const swapped = await runModelAgent(
      byId("B2"),
      cases,
      opts(scriptedModel([reply("gemini-other", [read])]).client),
    );
    expect(swapped.outcome).toMatchObject({ status: "failed", reason: "model_mismatch" });
    expect(swapped.turns).toBe(1);
  });

  it("labels a model error and a timeout", async () => {
    const { cases, opts } = setup();
    const errored = await runModelAgent(
      byId("B2"),
      cases,
      opts(scriptedModel([new Error("429 RESOURCE_EXHAUSTED")]).client),
    );
    expect(errored.outcome).toEqual({
      status: "failed",
      reason: "planner_error",
      message: "429 RESOURCE_EXHAUSTED",
    });
    expect(errored.turns).toBe(0);

    // A Vertex error body is shortened to its message on the summary line, kept whole in outcome.
    const vertex = JSON.stringify({
      error: { code: 403, message: `Permission denied ${"x".repeat(300)}`, status: "DENIED" },
    });
    const denied = await runModelAgent(
      byId("B2"),
      cases,
      opts(scriptedModel([new Error(vertex)]).client),
    );
    expect(denied.outcome).toMatchObject({ reason: "planner_error", message: vertex });
    const line = describeModelPlan("B2", denied);
    expect(line).toMatch(/PLAN FAILED \(planner_error: Permission denied x+…\), 0 refused/);
    expect(line.length).toBeLessThan(300);

    const hung = await runModelAgent(byId("B2"), cases, {
      ...opts({
        create: (_params, options) =>
          new Promise((_, reject) =>
            options?.signal?.addEventListener("abort", () => reject(options.signal?.reason)),
          ),
      }),
      timeoutMs: 20,
    });
    expect(hung.outcome).toMatchObject({ status: "failed", reason: "timeout" });
  });
});
