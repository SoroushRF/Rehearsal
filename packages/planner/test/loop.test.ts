import type Anthropic from "@anthropic-ai/sdk";
import { PlanManifest } from "@rehearsal/contracts";
import { evaluateBillingPolicy, validateGraph } from "@rehearsal/core";
import { STRIPE_CHARGE_PROJECTION, ZENDESK_TICKET_PROJECTION } from "@rehearsal/providers";
import { INCIDENT, incidentRecords } from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import {
  briefMessage,
  incidentBrief,
  type MessagesClient,
  PLANNING_TOOLS,
  type PlanningLoopError,
  PROMPT_VERSION,
  runPlanningLoop,
  SYSTEM_PROMPT,
} from "../src";
import { POLICY, world } from "./world";

const MODEL = "claude-sonnet-5-5";
const META = {
  orgId: "org_demo",
  planId: "plan_loop",
  adapters: { stripe: STRIPE_CHARGE_PROJECTION, zendesk: ZENDESK_TICKET_PROJECTION },
};
const BRIEF = incidentBrief(INCIDENT.incident);
if (!BRIEF) throw new Error("no brief for the seeded incident");
const CASES = incidentRecords().cases;

type Call = [name: string, input: Record<string, unknown>];

/** A model reply. Defaults to a turn of tool calls; pass stop to end or fail the turn. */
function reply(
  calls: Call[],
  extra: Partial<Pick<Anthropic.Message, "stop_reason" | "model" | "stop_details">> & {
    text?: string;
  } = {},
): Anthropic.Message {
  const content = [
    ...(extra.text ? [{ type: "text", text: extra.text, citations: null }] : []),
    ...calls.map(([name, input], i) => ({ type: "tool_use", id: `tu_${name}_${i}`, name, input })),
  ];
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: extra.model ?? MODEL,
    content,
    stop_reason: extra.stop_reason ?? (calls.length > 0 ? "tool_use" : "end_turn"),
    stop_sequence: null,
    stop_details: extra.stop_details ?? null,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 80 },
  } as unknown as Anthropic.Message;
}

/** Replays a fixed script and records every request it was sent. */
function scripted(turns: Anthropic.Message[]) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: MessagesClient = {
    async create(params) {
      // The loop keeps appending to one array; snapshot it as sent.
      requests.push(structuredClone(params));
      const next = turns[requests.length - 1];
      if (!next) throw new Error(`script has no turn ${requests.length}`);
      return next;
    },
  };
  return { client, requests };
}

/** What a careful agent does: read every customer, refund real duplicates, try one control. */
function happyScript(): Anthropic.Message[] {
  const duplicates = CASES.filter((c) => c.kind === "duplicate");
  const usd = CASES.find((c) => c.kind === "control_other_currency");
  if (!usd) throw new Error("no usd control");
  return [
    reply(CASES.map((c) => ["list_customer_charges", { customerId: c.customerId }])),
    reply(
      [...duplicates, usd].map((c) => [
        "propose_duplicate_refund",
        {
          chargeId: c.chargeIds[1],
          duplicateOfChargeId: c.chargeIds[0],
          rationale: `Second charge for ${c.invoices[1]}.`,
        },
      ]),
    ),
    reply(
      duplicates.flatMap((c): Call[] => [
        [
          "propose_ticket_priority",
          {
            customerId: c.customerId,
            ticketId: String(c.ticketId),
            priority: "high",
            rationale: "Refund in flight.",
          },
        ],
        [
          "propose_refund_note",
          { refundStepId: `refund_${c.chargeIds[1]}`, ticketId: String(c.ticketId) },
        ],
      ]),
    ),
    reply([], { text: "8 duplicates refunded; 3 customers had nothing to refund." }),
  ];
}

describe("planning loop", () => {
  it("turns a scripted investigation into a valid revision-1 plan", async () => {
    const { session } = world();
    const { client, requests } = scripted(happyScript());
    const result = await runPlanningLoop({
      client,
      model: MODEL,
      session,
      brief: BRIEF,
      meta: META,
    });

    const m = result.manifest;
    expect(PlanManifest.parse(m)).toEqual(m);
    expect(m.revision).toBe(1);
    expect(m).toMatchObject({
      orgId: "org_demo",
      planId: "plan_loop",
      incidentId: INCIDENT.incident,
    });
    expect(m.versions.planner).toMatchObject({ model: MODEL, promptVersion: PROMPT_VERSION });
    expect(m.actions).toHaveLength(8 * 3);
    expect(validateGraph(m.actions)).toEqual([]);
    expect(evaluateBillingPolicy(m, POLICY).violations).toEqual([]);
    expect(result).toMatchObject({ turns: 4, toolCalls: 11 + 9 + 16 });
    expect(result.summary).toMatch(/8 duplicates/);
    expect(result.usage).toEqual({ inputTokens: 400, outputTokens: 200, cacheReadTokens: 320 });

    // The USD control was refused, and the refusal went back to the model as an error result.
    const turn3 = requests[2]?.messages.at(-1);
    const results = (turn3?.content ?? []) as Anthropic.ToolResultBlockParam[];
    expect(results).toHaveLength(9);
    const usd = results.find((r) => r.is_error);
    expect(usd?.content).toMatch(/refunds only cad/);
  });

  it("offers only the planning tools, the versioned prompt and the brief", async () => {
    const { session } = world();
    const { client, requests } = scripted(happyScript());
    await runPlanningLoop({ client, model: MODEL, session, brief: BRIEF, meta: META });

    const first = requests[0];
    expect(first?.model).toBe(MODEL);
    expect(first?.system).toBe(SYSTEM_PROMPT);
    expect(first?.tools?.map((t) => (t as Anthropic.Tool).name).sort()).toEqual(
      Object.keys(PLANNING_TOOLS).sort(),
    );
    expect(first?.messages).toEqual([{ role: "user", content: briefMessage(BRIEF) }]);
    // Every request is the same prefix plus new turns, so the cache keeps hitting.
    expect(requests.every((r) => r.system === SYSTEM_PROMPT && r.tools?.length === 8)).toBe(true);
    expect(requests[3]?.messages.slice(0, 5)).toEqual(requests[2]?.messages);
  });

  it("tells the agent who reported the incident, but not what happened to them", () => {
    const text = briefMessage(BRIEF);
    for (const c of CASES) {
      expect(text).toContain(c.customerId);
      expect(text).toContain(String(c.requesterId));
      expect(text).not.toContain(c.chargeIds[0]);
      expect(text).not.toContain(String(c.amountMinor));
    }
    expect(text).not.toMatch(/control|duplicate charge of|usd/i);
    expect(incidentBrief("INC-OTHER")).toBeUndefined();
  });

  it("puts every tool result of a turn into one user message, in call order", async () => {
    const { session } = world();
    const { client, requests } = scripted(happyScript());
    await runPlanningLoop({ client, model: MODEL, session, brief: BRIEF, meta: META });
    const results = requests[1]?.messages.at(-1)?.content as Anthropic.ToolResultBlockParam[];
    expect(results.map((r) => r.tool_use_id)).toEqual(
      CASES.map((_, i) => `tu_list_customer_charges_${i}`),
    );
    expect(results.every((r) => r.type === "tool_result" && !r.is_error)).toBe(true);
  });

  const failures: [string, Anthropic.Message[], PlanningLoopError["reason"]][] = [
    ["a refusal", [reply([], { stop_reason: "refusal" })], "refusal"],
    ["a truncated turn", [reply([], { stop_reason: "max_tokens" })], "truncated"],
    ["another model answering", [reply([], { model: "claude-opus-5-5" })], "model_mismatch"],
    ["finishing without a step", [reply([], { text: "Nothing to do." })], "empty_plan"],
  ];
  it.each(failures)("fails closed on %s", async (_, turns, reason) => {
    const { session } = world();
    const { client } = scripted(turns);
    await expect(
      runPlanningLoop({ client, model: MODEL, session, brief: BRIEF, meta: META }),
    ).rejects.toMatchObject({ name: "PlanningLoopError", reason });
  });

  it("stops at the turn limit instead of storing a partial plan", async () => {
    const { session } = world();
    const c = CASES[0];
    const read = reply([["get_charge", { chargeId: c?.chargeIds[0] }]]);
    const { client, requests } = scripted([read, read, read]);
    await expect(
      runPlanningLoop({
        client,
        model: MODEL,
        session,
        brief: BRIEF,
        meta: META,
        limits: { maxTurns: 3 },
      }),
    ).rejects.toMatchObject({ reason: "turn_limit" });
    expect(requests).toHaveLength(3);
  });

  it("stops at the tool-call limit before running the excess calls", async () => {
    const { session, reads } = world();
    const { client } = scripted(happyScript());
    await expect(
      runPlanningLoop({
        client,
        model: MODEL,
        session,
        brief: BRIEF,
        meta: META,
        limits: { maxToolCalls: 5 },
      }),
    ).rejects.toMatchObject({ reason: "tool_call_limit" });
    expect(reads).toHaveLength(0);
  });

  it("feeds unknown tools and bad input back as errors the model can read", async () => {
    const { session } = world();
    const { client, requests } = scripted([
      reply([
        ["http_get", { url: "http://127.0.0.1:8102/v1/charges" }],
        ["get_charge", { chargeId: "ch_x", baseUrl: "http://evil" }],
      ]),
      reply([], { text: "Done." }),
    ]);
    await expect(
      runPlanningLoop({ client, model: MODEL, session, brief: BRIEF, meta: META }),
    ).rejects.toMatchObject({ reason: "empty_plan" });
    const results = requests[1]?.messages.at(-1)?.content as Anthropic.ToolResultBlockParam[];
    expect(results.map((r) => r.is_error)).toEqual([true, true]);
    expect(results[0]?.content).toMatch(/unknown tool http_get/);
  });
});
