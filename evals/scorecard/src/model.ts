import type { PlanManifest } from "@rehearsal/contracts";
import type { BillingPolicyV1, WorldContext } from "@rehearsal/core";
import {
  incidentBrief,
  type MessagesClient,
  PLANNING_TOOLS,
  PlanningLoopError,
  type PlanningReader,
  PlanningSession,
  PROMPT_VERSION,
  runPlanningLoop,
  type ToolResult,
} from "@rehearsal/planner";
import { INCIDENT, type SeededCase } from "@rehearsal/testkit";
import type { AgentResult, DecidedIntent, Intent } from "./agent";
import type { Priority, ScorecardTask } from "./tasks";

/**
 * T1.15: the scorecard's real-model planner. Each task is planned by `runPlanningLoop`, the same
 * bounded tool loop the planner worker runs, over the shared planning world. The model only ever
 * sees the planning tools; its client never reaches the apply side.
 *
 * Its plan is the session's manifest, as in the worker. Direct and per-call modes need the writes
 * the model *tried*, not only the ones the tools accepted, so a `RecordingSession` keeps every
 * schema-valid propose call as an Intent, with the facts direct mode needs to send it (read straight
 * from the planning world, so the plan's evidence is exactly what the model's own calls recorded).
 *
 * A task's `careless` entries are the scripted agent's deliberate mistakes; the model isn't told to
 * make them, so on those tasks the row measures whether it makes them on its own.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export const NO_TOKENS: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  };
}

/** Counts every model response, including the turn that ends a run with an error. */
export function meteredClient(client: MessagesClient) {
  const meter = { calls: 0, usage: { ...NO_TOKENS } };
  const metered: MessagesClient = {
    async create(params, options) {
      const res = await client.create(params, options);
      meter.calls++;
      meter.usage = addUsage(meter.usage, {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
      });
      return res;
    },
  };
  return { client: metered, meter };
}

interface ChargeFacts {
  customer: string;
  amount: number;
  currency: string;
}

/** A planning session that also keeps every propose call the model made, accepted or refused. */
export class RecordingSession extends PlanningSession {
  readonly decided: DecidedIntent[] = [];
  /** Propose calls that passed the schema but couldn't be turned into a write (e.g. no such charge). */
  readonly unsendable: string[] = [];
  readonly #readers: { stripe: PlanningReader; zendesk: PlanningReader };
  readonly #ctx: WorldContext;
  readonly #caseOf: (customerId: string) => string;

  constructor(
    opts: ConstructorParameters<typeof PlanningSession>[0],
    cases: readonly SeededCase[],
  ) {
    super(opts);
    this.#readers = opts.readers;
    this.#ctx = opts.ctx;
    const keys = new Map(cases.map((c) => [c.customerId, c.key]));
    // A customer outside the cohort keeps its own ID; it isn't scored, but direct mode sends it.
    this.#caseOf = (customerId) => keys.get(customerId) ?? customerId;
  }

  override async call(name: string, input: unknown): Promise<ToolResult> {
    const res = await super.call(name, input);
    if (!name.startsWith("propose_") || !Object.hasOwn(PLANNING_TOOLS, name)) return res;
    // A call that doesn't parse would be a malformed request in direct mode too: not a write.
    if (!PLANNING_TOOLS[name as keyof typeof PLANNING_TOOLS].input.safeParse(input).success) {
      return res;
    }
    try {
      const intent = await this.#intent(name, input as Record<string, string>);
      this.decided.push(
        res.ok ? { intent, accepted: true } : { intent, accepted: false, refusal: res.error },
      );
    } catch (e) {
      this.unsendable.push(`${name} ${JSON.stringify(input)}: ${(e as Error).message}`);
    }
    return res;
  }

  async #intent(name: string, input: Record<string, string>): Promise<Intent> {
    switch (name) {
      case "propose_duplicate_refund": {
        const i = input as Extract<Intent, { tool: "propose_duplicate_refund" }>["input"];
        const charge = await this.#charge(i.chargeId);
        return {
          caseKey: this.#caseOf(charge.customer),
          tool: "propose_duplicate_refund",
          input: i,
          amountMinor: charge.amount,
          currency: charge.currency,
        };
      }
      case "propose_ticket_priority": {
        const i = input as Extract<Intent, { tool: "propose_ticket_priority" }>["input"];
        const ticket = await this.#ticket(i.ticketId);
        return {
          caseKey: this.#caseOf(i.customerId),
          tool: "propose_ticket_priority",
          input: i,
          before: { priority: ticket.priority, status: ticket.status },
        };
      }
      case "propose_refund_note": {
        const i = input as Extract<Intent, { tool: "propose_refund_note" }>["input"];
        // The refund it confirms, as the model asked for it. Without one, direct mode skips it.
        const refund = this.decided.find(
          (d) =>
            d.intent.tool === "propose_duplicate_refund" &&
            refundStepId(d.intent) === i.refundStepId,
        )?.intent;
        if (refund?.tool === "propose_duplicate_refund") {
          return {
            caseKey: refund.caseKey,
            tool: "propose_refund_note",
            input: i,
            amountMinor: refund.amountMinor,
          };
        }
        const ticket = await this.#ticket(i.ticketId);
        return {
          caseKey: this.#caseOf(ticket.externalId ?? `ticket_${i.ticketId}`),
          tool: "propose_refund_note",
          input: i,
          amountMinor: 0,
        };
      }
      default:
        throw new Error(`no intent for ${name}`);
    }
  }

  async #charge(id: string): Promise<ChargeFacts> {
    const obs = await this.#readers.stripe.observe(
      { vendor: "stripe", kind: "charge", id },
      this.#ctx,
    );
    const p = obs.projection;
    return { customer: String(p.customer), amount: Number(p.amount), currency: String(p.currency) };
  }

  async #ticket(id: string) {
    const obs = await this.#readers.zendesk.observe(
      { vendor: "zendesk", kind: "ticket", id },
      this.#ctx,
    );
    const p = obs.projection;
    return {
      priority: (p.priority ?? null) as Priority | null,
      status: String(p.status),
      externalId: typeof p.external_id === "string" ? p.external_id : null,
    };
  }
}

function refundStepId(intent: Intent): string | undefined {
  return intent.tool === "propose_duplicate_refund" ? `refund_${intent.input.chargeId}` : undefined;
}

/** The incident brief limited to the task's scope: the model is asked about those customers only. */
export function scopedBrief(task: ScorecardTask, cases: readonly SeededCase[]) {
  const scope = new Set(cases.filter((c) => task.scope.includes(c.key)).map((c) => c.customerId));
  const brief = incidentBrief(INCIDENT.incident, {
    ...INCIDENT,
    cases: INCIDENT.cases.filter((c) => scope.has(c.customerId)),
  });
  if (!brief) throw new Error(`no brief for ${INCIDENT.incident}`);
  return brief;
}

/** How the model's planning run ended. `empty` is a finished run that proposed nothing. */
export type PlanOutcome =
  | { status: "planned" }
  | { status: "empty" }
  | {
      status: "failed";
      reason: PlanningLoopError["reason"] | "timeout" | "planner_error";
      message: string;
    };

export interface ModelAgentResult extends AgentResult {
  outcome: PlanOutcome;
  model: string;
  promptVersion: string;
  usage: TokenUsage;
  /** Model requests made, including one that ended the run with an error. */
  turns: number;
  toolCalls: number;
  summary: string;
  unsendable: string[];
}

export interface ModelAgentOptions {
  client: MessagesClient;
  model: string;
  readers: { stripe: PlanningReader; zendesk: PlanningReader };
  ctx: WorldContext;
  policy: BillingPolicyV1;
  meta: { orgId: string; incidentId: string; planId: string; adapters: Record<string, string> };
  timeoutMs?: number;
  limits?: Parameters<typeof runPlanningLoop>[0]["limits"];
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/**
 * Plan one task with the model. A failed run stores no plan, so Rehearsal gets an empty manifest
 * (nothing to approve, nothing applied); direct and per-call still get the writes the model tried
 * before it failed, because without a plan step those calls would already have gone out.
 */
export async function runModelAgent(
  task: ScorecardTask,
  cases: readonly SeededCase[],
  opts: ModelAgentOptions,
): Promise<ModelAgentResult> {
  const brief = scopedBrief(task, cases);
  const session = new RecordingSession(
    { readers: opts.readers, ctx: opts.ctx, policy: opts.policy, window: brief.window },
    cases,
  );
  const { client, meter } = meteredClient(opts.client);
  const manifestMeta = { ...opts.meta, model: opts.model, promptVersion: PROMPT_VERSION };
  const emptyPlan = (): PlanManifest => ({ ...session.manifest(manifestMeta), actions: [] });
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let toolCalls = 0;

  let outcome: PlanOutcome;
  let manifest: PlanManifest;
  let summary = "";
  try {
    const result = await runPlanningLoop({
      client,
      model: opts.model,
      session,
      brief,
      meta: { orgId: opts.meta.orgId, planId: opts.meta.planId, adapters: opts.meta.adapters },
      limits: opts.limits,
      signal,
      onTurn: (t) => {
        toolCalls += t.toolCalls.length;
      },
    });
    outcome = { status: "planned" };
    manifest = result.manifest;
    summary = result.summary;
  } catch (err) {
    if (err instanceof PlanningLoopError && err.reason === "empty_plan") {
      outcome = { status: "empty" };
      manifest = session.manifest(manifestMeta);
    } else {
      outcome = {
        status: "failed",
        reason:
          err instanceof PlanningLoopError
            ? err.reason
            : signal.aborted
              ? "timeout"
              : "planner_error",
        message: (err instanceof Error ? err.message : String(err)).slice(0, 2000),
      };
      manifest = emptyPlan();
    }
  }
  return {
    intents: session.decided,
    manifest,
    outcome,
    model: opts.model,
    promptVersion: PROMPT_VERSION,
    usage: meter.usage,
    turns: meter.calls,
    toolCalls,
    summary,
    unsendable: session.unsendable,
  };
}

/** One line per task for the console and the results file. */
export function describeModelPlan(taskId: string, r: ModelAgentResult): string {
  const u = r.usage;
  const tokens = `${u.inputTokens} in + ${u.cacheReadTokens} cached / ${u.outputTokens} out`;
  const refused = r.intents.filter((i) => !i.accepted).length;
  const how =
    r.outcome.status === "failed"
      ? `PLAN FAILED (${r.outcome.reason}: ${firstLine(r.outcome.message)})`
      : r.outcome.status === "empty"
        ? "no steps proposed"
        : `${r.manifest.actions.length} steps`;
  return `${taskId.padEnd(3)} plan      ${how}, ${refused} refused, ${r.turns} turns, ${r.toolCalls} tool calls, ${tokens}`;
}

/** An error's gist for a one-line summary; the full message stays in the results file. */
function firstLine(message: string, max = 160): string {
  const line = message.split("\n")[0] ?? "";
  // Vertex errors arrive as a JSON body; its message field is the readable part.
  const inner = /"message":"([^"]+)"/.exec(line)?.[1] ?? line;
  return inner.length > max ? `${inner.slice(0, max - 1)}…` : inner;
}
