import { randomUUID } from "node:crypto";
import type { PrecedentBasis } from "@rehearsal/contracts";
import type { BillingPolicy, WorldContext } from "@rehearsal/core";
import { type PrecedentRecall, recallBasis } from "@rehearsal/memory";
import {
  incidentBrief,
  type MessagesClient,
  type ModelAttempt,
  ModelRequestError,
  PlanningLoopError,
  type PlanningReader,
  PlanningSession,
  runPlanningLoop,
  storedIncidentBrief,
  type TurnLog,
} from "@rehearsal/planner";
import { type ClaimedPlanJob, type PlannerJobsClient, registryOfJob } from "@rehearsal/providers";

/** Everything a plan job needs. Only planning-world readers: the worker has nothing else. */
export interface PlanJobContext {
  jobs: PlannerJobsClient;
  client: MessagesClient;
  model: string;
  readers: { stripe: PlanningReader; zendesk: PlanningReader };
  ctx: WorldContext;
  policy: BillingPolicy;
  adapters: Record<string, string>;
  /** Slack channel for the run summary (T1.7); without it the planner proposes none. */
  summaryChannelId?: string;
  /** Public replies to customers (T1.13), named from the incident report; off unless set. */
  customerReplies?: boolean;
  /** Invoice-balance credits instead of small refunds (T1.14); needs a policy with a credit limit. */
  balanceCredits?: boolean;
  /**
   * Agent Memory recall in an org's own scope (#235), or absent in core mode. A job whose org has
   * active precedents then fails instead of planning without them.
   */
  precedents?: (orgId: string) => { recall(caseKey: string): Promise<PrecedentRecall> };
  /** Hard wall-clock bound on one run, on top of the loop's turn and call limits. */
  timeoutMs?: number;
  log?: (line: string) => void;
}

export type PlanJobResult =
  | { kind: "stored"; planId: string; planHash: string }
  | { kind: "failed"; reason: string; message: string };

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const NO_RECALL = {
  recall: async (): Promise<PrecedentRecall> => ({ precedents: [], traceId: null, rejected: [] }),
};

/**
 * Run one claimed `plan` job: plan in the planning world, then hand the manifest to the API, which
 * checks it against the job and stores it as revision 1. Any failure is reported on the job, so
 * the review page can show it; a failure to report is thrown and the job expires and retries.
 */
export async function handlePlanJob(
  claimed: ClaimedPlanJob,
  deps: PlanJobContext,
): Promise<PlanJobResult> {
  const job = claimed.data;
  const log = deps.log ?? (() => {});
  const modelAttempts: ModelAttempt[] = [];
  const fail = async (reason: string, message: string): Promise<PlanJobResult> => {
    await deps.jobs.fail(claimed.id, { reason, message, modelAttempts });
    return { kind: "failed", reason, message };
  };

  // A filed incident comes with the job (the worker has no database); a built-in one by ID.
  if (job.incident && job.incident.incidentId !== job.incidentId) {
    return fail("unknown_incident", "the job's incident is not the one it names");
  }
  const brief = job.incident ? storedIncidentBrief(job.incident) : incidentBrief(job.incidentId);
  if (!brief) return fail("unknown_incident", `no brief for ${job.incidentId}`);

  let recalled: Awaited<ReturnType<typeof recallBasis>> = null;
  if (job.precedents) {
    const registry = registryOfJob(job.precedents);
    if (registry.active.size > 0 && !deps.precedents) {
      return fail("precedents_unavailable", "the org has active precedents but no Agent Memory");
    }
    try {
      // With nothing active, recallBasis records the epochs without recalling.
      recalled = await recallBasis(deps.precedents?.(job.orgId) ?? NO_RECALL, registry);
    } catch (err) {
      // An outage blocks a plan that depends on memory rather than planning without it (§7).
      return fail("precedent_recall_failed", (err as Error).message.slice(0, 2000));
    }
    for (const d of recalled?.dropped ?? []) log(`precedent ${d.id} not cited: ${d.reason}`);
  }
  const basis: PrecedentBasis | undefined = recalled?.basis;
  if (recalled && recalled.precedents.length > 0) {
    brief.precedents = recalled.precedents.map((p) => ({
      id: p.id,
      version: p.version,
      statement: p.record.statement,
      conditions: p.record.conditions,
      exceptions: p.record.exceptions,
    }));
  }

  const session = new PlanningSession({
    readers: deps.readers,
    ctx: deps.ctx,
    policy: deps.policy,
    window: brief.window,
    ...(brief.mode && { mode: brief.mode }),
    ...(deps.summaryChannelId && {
      runSummary: { channelId: deps.summaryChannelId, incidentId: brief.incident },
    }),
    ...(deps.balanceCredits && { credits: true }),
    ...(deps.customerReplies && {
      customerNames: Object.fromEntries(brief.customers.map((c) => [c.customerId, c.name])),
    }),
  });
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  const timedOut = () => fail("timeout", `no plan within ${timeoutMs} ms`);
  const run = randomUUID().slice(0, 8);
  log(`[${run}] planning ${job.incidentId} for ${job.orgId} as ${job.planId} (${deps.model})`);
  let result: Awaited<ReturnType<typeof runPlanningLoop>>;
  try {
    result = await runPlanningLoop({
      client: deps.client,
      model: deps.model,
      session,
      brief,
      meta: {
        orgId: job.orgId,
        planId: job.planId,
        adapters: deps.adapters,
        ...(basis && { precedentBasis: basis }),
      },
      signal,
      onTurn: (t: TurnLog) => log(`[${run}] turn ${t.turn}: ${describe(t)}`),
      onModelAttempt: (attempt) => {
        modelAttempts.push(attempt);
        log(`[${run}] model turn ${attempt.turn} attempt ${attempt.attempt}: ${attempt.outcome}`);
      },
    });
  } catch (err) {
    if (err instanceof PlanningLoopError) return fail(err.reason, err.message);
    if (signal.aborted) return timedOut();
    if (err instanceof ModelRequestError) return fail(err.reason, err.message);
    const outcome = modelAttempts.at(-1)?.outcome;
    if (outcome && outcome !== "succeeded" && outcome !== "error" && outcome !== "aborted") {
      return fail(`model_${outcome}`, (err as Error).message.slice(0, 2000));
    }
    // A model or network error. Reported, so the job retries once instead of hanging until expiry.
    return fail("planner_error", (err as Error).message.slice(0, 2000));
  }
  // Past the deadline the queue may already have expired the job; don't hand back a late plan.
  // The jobs client bounds each API call on its own, so reporting can't hang either.
  if (signal.aborted) return timedOut();

  const { planHash } = await deps.jobs.complete(claimed.id, {
    manifest: result.manifest,
    summary: result.summary.slice(0, 4000),
    stats: { turns: result.turns, toolCalls: result.toolCalls, usage: result.usage, modelAttempts },
  });
  log(
    `[${run}] stored ${job.planId} r1 ${planHash}: ${result.manifest.actions.length} steps, ` +
      `${result.turns} turns, ${result.toolCalls} tool calls`,
  );
  return { kind: "stored", planId: job.planId, planHash };
}

function describe(t: TurnLog): string {
  if (t.toolCalls.length === 0) return `${t.stopReason}`;
  return t.toolCalls
    .map((c) => (c.ok ? c.name : `${c.name} ✗ ${c.error?.split("\n")[0]}`))
    .join(", ");
}
