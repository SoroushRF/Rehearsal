import { randomUUID } from "node:crypto";
import type { BillingPolicyV1, WorldContext } from "@rehearsal/core";
import {
  incidentBrief,
  type MessagesClient,
  PlanningLoopError,
  type PlanningReader,
  PlanningSession,
  runPlanningLoop,
  type TurnLog,
} from "@rehearsal/planner";
import type { ClaimedPlanJob, PlannerJobsClient } from "@rehearsal/providers";

/** Everything a plan job needs. Only planning-world readers: the worker has nothing else. */
export interface PlanJobContext {
  jobs: PlannerJobsClient;
  client: MessagesClient;
  model: string;
  readers: { stripe: PlanningReader; zendesk: PlanningReader };
  ctx: WorldContext;
  policy: BillingPolicyV1;
  adapters: Record<string, string>;
  /** Hard wall-clock bound on one run, on top of the loop's turn and call limits. */
  timeoutMs?: number;
  log?: (line: string) => void;
}

export type PlanJobResult =
  | { kind: "stored"; planId: string; planHash: string }
  | { kind: "failed"; reason: string; message: string };

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

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
  const fail = async (reason: string, message: string): Promise<PlanJobResult> => {
    await deps.jobs.fail(claimed.id, { reason, message });
    return { kind: "failed", reason, message };
  };

  const brief = incidentBrief(job.incidentId);
  if (!brief) return fail("unknown_incident", `no brief for ${job.incidentId}`);

  const session = new PlanningSession({
    readers: deps.readers,
    ctx: deps.ctx,
    policy: deps.policy,
    window: brief.window,
  });
  const signal = AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const run = randomUUID().slice(0, 8);
  log(`[${run}] planning ${job.incidentId} for ${job.orgId} as ${job.planId} (${deps.model})`);
  let result: Awaited<ReturnType<typeof runPlanningLoop>>;
  try {
    result = await runPlanningLoop({
      client: deps.client,
      model: deps.model,
      session,
      brief,
      meta: { orgId: job.orgId, planId: job.planId, adapters: deps.adapters },
      signal,
      onTurn: (t: TurnLog) => log(`[${run}] turn ${t.turn}: ${describe(t)}`),
    });
  } catch (err) {
    if (err instanceof PlanningLoopError) return fail(err.reason, err.message);
    if (signal.aborted)
      return fail("timeout", `no plan within ${deps.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`);
    // A model or network error. Reported, so the job retries once instead of hanging until expiry.
    return fail("planner_error", (err as Error).message.slice(0, 2000));
  }

  const { planHash } = await deps.jobs.complete(claimed.id, {
    manifest: result.manifest,
    summary: result.summary.slice(0, 4000),
    stats: { turns: result.turns, toolCalls: result.toolCalls, usage: result.usage },
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
