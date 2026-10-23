import type Anthropic from "@anthropic-ai/sdk";
import type { PlanManifest } from "@rehearsal/contracts";
import { validateGraph } from "@rehearsal/core";
import {
  briefMessage,
  type IncidentBrief,
  LOOP_LIMITS,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
} from "./prompt";
import { type PlanningSession, planningToolDefinitions } from "./tools";

/**
 * T1.5: the bounded tool loop. The model sees only the planning tools, so it has no shell, browser
 * or raw HTTP. Every tool call goes through `PlanningSession.call`, which validates the input and
 * records the evidence. The plan is the session's manifest, never anything the model writes. Any
 * way the loop can end other than a finished turn (limits, refusal, truncation, a substituted
 * model) fails the run instead of storing a partial plan.
 */

/** The one Messages API call the loop makes. `client.messages` satisfies it; tests script it. */
export interface MessagesClient {
  create(
    params: Anthropic.MessageCreateParamsNonStreaming,
    options?: { signal?: AbortSignal },
  ): Promise<Anthropic.Message>;
}

export interface PlanningLoopOptions {
  client: MessagesClient;
  /** Pinned model ID. Recorded in the manifest. */
  model: string;
  session: PlanningSession;
  brief: IncidentBrief;
  meta: { orgId: string; planId: string; adapters: Record<string, string> };
  limits?: Partial<Record<"maxTurns" | "maxToolCalls" | "maxTokensPerTurn", number>>;
  signal?: AbortSignal;
  /** Called after every turn, for logs. */
  onTurn?: (turn: TurnLog) => void;
}

export interface TurnLog {
  turn: number;
  stopReason: Anthropic.StopReason | null;
  toolCalls: { name: string; ok: boolean; error?: string }[];
  usage: Anthropic.Usage;
}

export interface PlanningResult {
  manifest: PlanManifest;
  /** The model's closing summary. For logs and the job result only; never part of the plan. */
  summary: string;
  turns: number;
  toolCalls: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
}

export class PlanningLoopError extends Error {
  constructor(
    readonly reason:
      | "turn_limit"
      | "tool_call_limit"
      | "refusal"
      | "truncated"
      | "model_mismatch"
      | "empty_plan"
      | "invalid_plan",
    message: string,
  ) {
    super(message);
    this.name = "PlanningLoopError";
  }
}

export async function runPlanningLoop(opts: PlanningLoopOptions): Promise<PlanningResult> {
  const limits = { ...LOOP_LIMITS, ...opts.limits };
  const tools: Anthropic.Tool[] = planningToolDefinitions().map((t) => ({
    ...t,
    input_schema: t.input_schema as Anthropic.Tool.InputSchema,
  }));
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: briefMessage(opts.brief) }];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  let toolCalls = 0;

  for (let turn = 1; turn <= limits.maxTurns; turn++) {
    const response = await opts.client.create(
      {
        model: opts.model,
        max_tokens: limits.maxTokensPerTurn,
        system: SYSTEM_PROMPT,
        tools,
        tool_choice: { type: "auto" },
        output_config: { effort: LOOP_LIMITS.effort },
        // Tools and system never change within a run; caching the growing prefix keeps each
        // turn from paying for the whole history again.
        cache_control: { type: "ephemeral" },
        messages,
      },
      { signal: opts.signal },
    );
    usage.inputTokens += response.usage.input_tokens;
    usage.outputTokens += response.usage.output_tokens;
    usage.cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;

    // The manifest records the requested model, so the plan must come from exactly that model.
    if (response.model !== opts.model) {
      throw new PlanningLoopError(
        "model_mismatch",
        `asked for ${opts.model}, served by ${response.model}`,
      );
    }
    if (response.stop_reason === "refusal") {
      throw new PlanningLoopError(
        "refusal",
        `model declined (${response.stop_details?.category ?? "no category"})`,
      );
    }
    if (
      response.stop_reason === "max_tokens" ||
      response.stop_reason === "model_context_window_exceeded"
    ) {
      throw new PlanningLoopError("truncated", `turn ${turn} stopped at ${response.stop_reason}`);
    }

    // Thinking and tool_use blocks go back unchanged; the API needs them to continue the turn.
    messages.push({ role: "assistant", content: response.content });
    const calls = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const log: TurnLog = {
      turn,
      stopReason: response.stop_reason,
      toolCalls: [],
      usage: response.usage,
    };

    if (calls.length === 0) {
      opts.onTurn?.(log);
      if (response.stop_reason === "pause_turn") continue;
      return finish(opts, response, turn, toolCalls, usage);
    }

    toolCalls += calls.length;
    if (toolCalls > limits.maxToolCalls) {
      throw new PlanningLoopError("tool_call_limit", `more than ${limits.maxToolCalls} tool calls`);
    }
    // Sequential, in the model's order: propose tools depend on what earlier calls proposed.
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of calls) {
      const result = await opts.session.call(call.name, call.input);
      log.toolCalls.push(
        result.ok
          ? { name: call.name, ok: true }
          : { name: call.name, ok: false, error: result.error },
      );
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: JSON.stringify(result.ok ? result.result : { error: result.error }),
        ...(!result.ok && { is_error: true }),
      });
    }
    // All results of a turn go back in one message.
    messages.push({ role: "user", content: results });
    opts.onTurn?.(log);
  }
  throw new PlanningLoopError("turn_limit", `no finished plan after ${limits.maxTurns} turns`);
}

function finish(
  opts: PlanningLoopOptions,
  response: Anthropic.Message,
  turns: number,
  toolCalls: number,
  usage: PlanningResult["usage"],
): PlanningResult {
  const manifest = opts.session.manifest({
    orgId: opts.meta.orgId,
    incidentId: opts.brief.incident,
    planId: opts.meta.planId,
    model: opts.model,
    promptVersion: PROMPT_VERSION,
    adapters: opts.meta.adapters,
  });
  if (manifest.actions.length === 0) {
    throw new PlanningLoopError("empty_plan", "the model finished without proposing any step");
  }
  const problems = validateGraph(manifest.actions);
  if (problems.length > 0) {
    throw new PlanningLoopError(
      "invalid_plan",
      `plan graph is invalid: ${JSON.stringify(problems)}`,
    );
  }
  const summary = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return { manifest, summary, turns, toolCalls, usage };
}
