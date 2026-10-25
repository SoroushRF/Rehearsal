import type Anthropic from "@anthropic-ai/sdk";
import {
  type Content,
  FinishReason,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type Part,
  ThinkingLevel,
} from "@google/genai";
import type { MessagesClient } from "@rehearsal/planner";

/**
 * Gemini behind the planner loop's `MessagesClient`. The loop stays the one bounded tool loop: it
 * still enforces the turn, tool-call and token limits, the served-model check and the refusal and
 * truncation stops. This only translates one Messages request into one `generateContent` call and
 * the answer back. Gemini's thought signatures must come back unchanged, so each assistant turn
 * is replayed from the exact `Content` the model returned, never rebuilt from the blocks.
 */

/** The one call the adapter makes. `new GoogleGenAI(...).models` satisfies it; tests script it. */
export interface GenerateContentClient {
  generateContent(params: {
    model: string;
    contents: Content[];
    config?: GenerateContentConfig;
  }): Promise<GenerateContentResponse>;
}

const REFUSALS = new Set<string>([
  FinishReason.SAFETY,
  FinishReason.RECITATION,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
  FinishReason.IMAGE_SAFETY,
  FinishReason.IMAGE_PROHIBITED_CONTENT,
]);

const THINKING: Record<string, ThinkingLevel> = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

export function geminiMessagesClient(models: GenerateContentClient): MessagesClient {
  // Keyed by the content array the loop pushes back unchanged as the assistant message.
  const raw = new WeakMap<object, Content>();
  return {
    async create(params, options) {
      const response = await models.generateContent({
        model: params.model,
        contents: toContents(params.messages, raw),
        config: {
          systemInstruction: typeof params.system === "string" ? params.system : undefined,
          maxOutputTokens: params.max_tokens,
          candidateCount: 1,
          tools: [
            {
              functionDeclarations: (params.tools ?? []).map((t) => {
                const tool = t as Anthropic.Tool;
                return {
                  name: tool.name,
                  description: tool.description,
                  parametersJsonSchema: tool.input_schema,
                };
              }),
            },
          ],
          thinkingConfig: { thinkingLevel: THINKING[params.output_config?.effort ?? "medium"] },
          abortSignal: options?.signal,
        },
      });
      const message = toMessage(response);
      const content = response.candidates?.[0]?.content;
      if (content) raw.set(message.content, content);
      return message;
    },
  };
}

function toContents(messages: Anthropic.MessageParam[], raw: WeakMap<object, Content>): Content[] {
  const names = new Map<string, string>();
  return messages.map((m): Content => {
    if (typeof m.content === "string")
      return { role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] };
    if (m.role === "assistant") {
      for (const b of m.content) if (b.type === "tool_use") names.set(b.id, b.name);
      const replay = raw.get(m.content);
      if (!replay) throw new Error("gemini: assistant turn has no recorded model content");
      return replay;
    }
    const parts = m.content.map((b): Part => {
      if (b.type === "text") return { text: b.text };
      if (b.type !== "tool_result") throw new Error(`gemini: unsupported block ${b.type}`);
      const name = names.get(b.tool_use_id);
      if (!name) throw new Error(`gemini: result for unknown call ${b.tool_use_id}`);
      const parsed: unknown = JSON.parse(typeof b.content === "string" ? b.content : "null");
      return {
        functionResponse: {
          id: b.tool_use_id,
          name,
          response: b.is_error ? (parsed as Record<string, unknown>) : { output: parsed },
        },
      };
    });
    return { role: "user", parts };
  });
}

function toMessage(response: GenerateContentResponse): Anthropic.Message {
  const id = response.responseId ?? "gemini";
  const candidate = response.candidates?.[0];
  const reason = candidate?.finishReason ?? response.promptFeedback?.blockReason;
  const content: Anthropic.ContentBlock[] = [];
  for (const [i, part] of (candidate?.content?.parts ?? []).entries()) {
    if (part.functionCall) {
      content.push({
        type: "tool_use",
        id: part.functionCall.id ?? `${id}_${i}`,
        name: part.functionCall.name ?? "",
        input: part.functionCall.args ?? {},
      } as Anthropic.ToolUseBlock);
    } else if (part.text && !part.thought) {
      content.push({ type: "text", text: part.text, citations: null } as Anthropic.TextBlock);
    }
  }

  let stop: Anthropic.StopReason;
  if (response.promptFeedback?.blockReason || (reason && REFUSALS.has(reason))) stop = "refusal";
  else if (reason === FinishReason.MAX_TOKENS) stop = "max_tokens";
  else if (reason === FinishReason.STOP)
    stop = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
  // A malformed or unexpected call, or no answer at all: an error, so the job reports and retries.
  else throw new Error(`gemini: turn ended with ${reason ?? "no candidate"}`);

  const u = response.usageMetadata;
  const cached = u?.cachedContentTokenCount ?? 0;
  return {
    id,
    type: "message",
    role: "assistant",
    model: response.modelVersion ?? "",
    content,
    stop_reason: stop,
    stop_sequence: null,
    stop_details: stop === "refusal" ? { type: "refusal", category: reason ?? null } : null,
    usage: {
      input_tokens: (u?.promptTokenCount ?? 0) - cached,
      // Thinking is billed as output.
      output_tokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
    },
  } as unknown as Anthropic.Message;
}
