import { Sha256Hex, StoredIncident } from "@rehearsal/contracts";
import { z } from "zod";

/**
 * T1.5: the planner worker's side of the API. Like tenant tokens, the worker reaches its jobs
 * through the API with its own secret and never holds a database URL
 * (docs/decisions/0006-planner-jobs-through-api.md).
 */
export const PLANNER_JOB_ROUTES = {
  next: "/internal/planner/jobs/next",
  complete: "/internal/planner/jobs/:id/complete",
  fail: "/internal/planner/jobs/:id/fail",
} as const;

/**
 * The org's precedent registry when the job was created (#235), as JSON: the active version of each
 * precedent and every area's epoch. The worker has no database, so this is how it learns which
 * recalled precedents it may cite; the API checks the plan's basis against the same snapshot.
 */
export const PlanJobRegistry = z.strictObject({
  active: z.array(
    z.strictObject({ id: z.string().min(1), version: z.int().positive(), digest: Sha256Hex }),
  ),
  epochs: z.record(z.string().min(1), z.int().nonnegative()),
});
export type PlanJobRegistry = z.infer<typeof PlanJobRegistry>;

/**
 * Live demo (#331): an incident the org filed, copied from its stored row by the API. The worker has
 * no database, so the job carries it. Absent for the built-in incidents, which the worker knows.
 */
export const PlanJobIncident = StoredIncident.pick({
  incidentId: true,
  kind: true,
  title: true,
  description: true,
  window: true,
});
export type PlanJobIncident = z.infer<typeof PlanJobIncident>;

/** A request to rehearse one incident for one org. The plan ID is fixed when the job is created. */
export const PlanJob = z.object({
  orgId: z.string().min(1),
  incidentId: z.string().min(1),
  planId: z.string().min(1),
  requestedBy: z.string().min(1),
  /** Absent when precedents aren't wired (core mode): the plan then carries no basis. */
  precedents: PlanJobRegistry.optional(),
  incident: PlanJobIncident.optional(),
});
export type PlanJob = z.infer<typeof PlanJob>;

/** `POST next` answers 204 when there is nothing to do, or one claimed job. */
export const ClaimedPlanJob = z.object({ id: z.uuid(), data: PlanJob });
export type ClaimedPlanJob = z.infer<typeof ClaimedPlanJob>;

/** The job's registry in the shape `checkPrecedentBasis` and `recallBasis` take. */
export function registryOfJob(r: PlanJobRegistry): {
  active: Map<string, { version: number; digest: Sha256Hex }>;
  epochs: Map<string, number>;
} {
  return {
    active: new Map(r.active.map(({ id, ...v }) => [id, v])),
    epochs: new Map(Object.entries(r.epochs)),
  };
}

/** Request history is diagnostic data, never execution authority or confirmed token usage. */
export const PlanModelAttempt = z.strictObject({
  turn: z.int().positive(),
  attempt: z.int().positive(),
  outcome: z.enum([
    "succeeded",
    "timeout",
    "rate_limit",
    "conflict",
    "network",
    "server_error",
    "error",
    "aborted",
  ]),
  reservedOutputTokens: z.int().positive(),
});
export const PlanModelAttempts = z.array(PlanModelAttempt).max(44);

export interface CompletePlanJob {
  manifest: unknown;
  summary: string;
  stats?: {
    turns: number;
    toolCalls: number;
    usage: Record<string, number>;
    modelAttempts?: z.infer<typeof PlanModelAttempts>;
  };
}

export interface FailPlanJob {
  reason: string;
  message: string;
  modelAttempts?: z.infer<typeof PlanModelAttempts>;
}

/**
 * The worker's client for those routes. Errors carry the status so the caller can log them. Each
 * call gives up after `timeoutMs`, so an API that never answers can't hold the serial worker.
 *
 * Redirects are refused, never followed: every request carries the worker's secret, and Fetch
 * keeps the Authorization header on a same-origin redirect, so a proxy that sends `/internal/…`
 * somewhere else would hand that service the secret (#242). Same policy as the Era transports.
 */
export function plannerJobsClient(
  apiUrl: string,
  secret: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 30_000,
) {
  const base = apiUrl.replace(/\/$/, "");
  const post = (path: string, body?: unknown) =>
    fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  const expect = async (res: Response, ok: number[], what: string) => {
    if (!ok.includes(res.status)) {
      throw new Error(`${what} → ${res.status} ${(await res.text()).slice(0, 500)}`);
    }
    return res;
  };
  return {
    async next(): Promise<ClaimedPlanJob | null> {
      const res = await expect(await post(PLANNER_JOB_ROUTES.next), [200, 204], "next plan job");
      return res.status === 204 ? null : ClaimedPlanJob.parse(await res.json());
    },
    async complete(id: string, body: CompletePlanJob): Promise<{ planHash: string }> {
      const path = PLANNER_JOB_ROUTES.complete.replace(":id", encodeURIComponent(id));
      const res = await expect(await post(path, body), [201], "complete plan job");
      return z.object({ planHash: z.string() }).parse(await res.json());
    },
    async fail(id: string, body: FailPlanJob): Promise<void> {
      const path = PLANNER_JOB_ROUTES.fail.replace(":id", encodeURIComponent(id));
      await expect(await post(path, body), [204], "fail plan job");
    },
  };
}
export type PlannerJobsClient = ReturnType<typeof plannerJobsClient>;
