/** Opt-in real-model check over fixture readers. No API job, approval or operational write. */
import { GoogleGenAI } from "@google/genai";
import { evaluateBillingPolicy } from "@rehearsal/core";
import {
  incidentBrief,
  PlanningLoopError,
  runPlanningLoop,
  type TurnLog,
} from "@rehearsal/planner";
import { INCIDENT, incidentRecords } from "@rehearsal/testkit";
import { POLICY_V2, world } from "../../../packages/planner/test/world";
import { geminiMessagesClient } from "../src/gemini";

const model = process.env.CREDIT_VALIDATION_MODEL || "gemini-4-argon";
const project = process.env.GOOGLE_CLOUD_PROJECT;
if (!project) throw new Error("GOOGLE_CLOUD_PROJECT is required (ADC authentication)");
const client = geminiMessagesClient(
  new GoogleGenAI({
    vertexai: true,
    project,
    location: process.env.GOOGLE_CLOUD_LOCATION || "global",
    httpOptions: { retryOptions: { attempts: 1 } },
  }).models,
);
for (const scenario of ["credit", "limit", "currency"] as const) {
  const c = incidentRecords().cases.find((x) => x.key === (scenario === "limit" ? "c02" : "c01"));
  const brief = incidentBrief(INCIDENT.incident);
  if (!c || !brief) throw new Error("missing fixture incident");
  brief.customers = brief.customers.filter((x) => x.customerId === c.customerId);
  const { session, customerCurrencies } = world({
    credits: true,
    policy: POLICY_V2,
    customerNames: Object.fromEntries(brief.customers.map((x) => [x.customerId, x.name])),
    runSummary: { channelId: "C_FIXTURE", incidentId: brief.incident },
  });
  customerCurrencies.set(c.customerId, scenario === "currency" ? "usd" : "cad");
  const turns: TurnLog[] = [];
  let completed = false;
  let error: string | null = null;
  let errorReason: string | null = null;
  let violations: unknown[] = [];
  try {
    const result = await runPlanningLoop({
      client,
      model,
      session,
      brief,
      meta: { orgId: "org_fixture_validation", planId: `plan_credit_${scenario}`, adapters: {} },
      signal: AbortSignal.timeout(120_000),
      limits: { maxTurns: 8, maxToolCalls: 30, maxTokensPerTurn: 8192 },
      onTurn: (turn) => turns.push(turn),
    });
    violations = evaluateBillingPolicy(result.manifest, POLICY_V2).violations;
    completed = true;
  } catch (e) {
    error = (e as Error).message;
    errorReason = e instanceof PlanningLoopError ? e.reason : "provider_error";
  }
  const calls = turns.flatMap((turn) => turn.toolCalls);
  const rejected = calls.filter((call) => !call.ok);
  console.log(
    JSON.stringify({
      scenario,
      evidence: "real_model_fixture_readers",
      model,
      completed,
      error,
      errorReason,
      toolCalls: calls.length,
      rejectedCalls: rejected.length,
      rejectedCallRate: calls.length ? rejected.length / calls.length : null,
      rejections: rejected.map((call) => ({ name: call.name, error: call.error })),
      actions: session.actions.map((a) => ({
        kind: a.kind,
        template: "template" in a.args ? a.args.template : undefined,
      })),
      violations,
      usage: turns.reduce(
        (sum, turn) => ({
          inputTokens: sum.inputTokens + turn.usage.input_tokens,
          outputTokens: sum.outputTokens + turn.usage.output_tokens,
        }),
        { inputTokens: 0, outputTokens: 0 },
      ),
    }),
  );
  const expected = scenario === "credit" ? "stripe.customer.balanceCredit" : "stripe.refund.create";
  if (
    violations.length ||
    (scenario === "currency"
      ? completed || errorReason !== "incomplete_plan" || session.actions.length > 0
      : !completed || !session.actions.some((a) => a.kind === expected))
  )
    process.exitCode = 1;
}
