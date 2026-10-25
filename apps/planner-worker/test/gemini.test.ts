import type { Content, GenerateContentConfig, GenerateContentResponse } from "@google/genai";
import {
  type IncidentBrief,
  incidentBrief,
  PlanningLoopError,
  PlanningSession,
  runPlanningLoop,
} from "@rehearsal/planner";
import { INCIDENT } from "@rehearsal/testkit";
import { describe, expect, it } from "vitest";
import policy from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import { type GenerateContentClient, geminiMessagesClient } from "../src/gemini";

const MODEL = "gemini-4-argon";
const brief = incidentBrief(INCIDENT.incident) as IncidentBrief;

/** Scripted Gemini: hands out responses in order and records every request. */
function scripted(responses: object[]) {
  const calls: { contents: Content[]; config?: GenerateContentConfig }[] = [];
  const models: GenerateContentClient = {
    async generateContent(params) {
      calls.push({ contents: structuredClone(params.contents), config: params.config });
      const next = responses.shift();
      if (!next) throw new Error("no scripted response");
      return {
        modelVersion: MODEL,
        responseId: `r${calls.length}`,
        ...next,
      } as GenerateContentResponse;
    },
  };
  return { models, calls };
}

const unused = async () => {
  throw new Error("404");
};

const loop = (models: GenerateContentClient, limits?: { maxTurns: number }) =>
  runPlanningLoop({
    client: geminiMessagesClient(models),
    model: MODEL,
    session: new PlanningSession({
      readers: {
        stripe: { vendor: "stripe", observe: unused, query: unused },
        zendesk: { vendor: "zendesk", observe: unused, query: unused },
      },
      ctx: { world: "planning", tenant: "t" },
      policy: policy as never,
      window: brief.window,
    }),
    brief,
    meta: { orgId: "org", planId: "plan", adapters: {} },
    limits,
  });

const modelTurn = (signature: string) => ({
  role: "model",
  parts: [
    {
      functionCall: { name: "get_charge", args: { chargeId: "ch_missing" } },
      thoughtSignature: signature,
    },
  ],
});
const reply = (finishReason: string, content?: object) => ({
  candidates: [{ content, finishReason }],
});

describe("geminiMessagesClient", () => {
  it("sends tools and limits, and replays the model turn with its thought signature", async () => {
    const { models, calls } = scripted([
      reply("STOP", modelTurn("sig-1")),
      reply("STOP", modelTurn("sig-2")),
    ]);
    await expect(loop(models, { maxTurns: 2 })).rejects.toMatchObject({ reason: "turn_limit" });

    const config = calls[0]?.config;
    expect(config?.systemInstruction).toContain("planning agent");
    expect(config?.maxOutputTokens).toBe(16_000);
    const tools = config?.tools?.[0];
    expect(tools && "functionDeclarations" in tools && tools.functionDeclarations?.length).toBe(9);

    const replay = calls[1]?.contents;
    expect(replay?.[1]).toEqual(modelTurn("sig-1"));
    const response = replay?.[2]?.parts?.[0]?.functionResponse;
    expect(response?.name).toBe("get_charge");
    expect(response?.id).toBe("r1_0");
    expect(response?.response).toHaveProperty("error");
  });

  it("fails the run when another model serves it", async () => {
    const { models } = scripted([
      { ...reply("STOP", modelTurn("s")), modelVersion: "gemini-4-flash" },
    ]);
    await expect(loop(models)).rejects.toMatchObject({ reason: "model_mismatch" });
  });

  it("maps safety stops to a refusal and token limits to truncation", async () => {
    await expect(loop(scripted([reply("SAFETY")]).models)).rejects.toMatchObject({
      reason: "refusal",
    });
    await expect(
      loop(scripted([reply("MAX_TOKENS", modelTurn("s"))]).models),
    ).rejects.toMatchObject({ reason: "truncated" });
  });

  it("treats a malformed call as an error, not a finished plan", async () => {
    const err = await loop(
      scripted([reply("MALFORMED_FUNCTION_CALL", { role: "model", parts: [] })]).models,
    ).catch((e) => e);
    expect(err).not.toBeInstanceOf(PlanningLoopError);
    expect((err as Error).message).toContain("MALFORMED_FUNCTION_CALL");
  });
});
