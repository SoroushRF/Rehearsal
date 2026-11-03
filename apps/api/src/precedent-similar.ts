import {
  AgentMemoryClient,
  AgentMemoryPrecedents,
  memoryConfigFromEnv,
  type PrecedentRecall,
  precedentScope,
} from "@rehearsal/memory";

/** What the promote panel's hint needs from Agent Memory: one recall, nothing else. */
export interface SimilarRecaller {
  recall(caseKey: string): Promise<PrecedentRecall>;
}
export type SimilarRecallerFor = (orgId: string) => SimilarRecaller;

/** Hosted recall takes 5–8 s (docs/agent-memory.md); past this the panel says it couldn't check. */
export const SIMILAR_TIMEOUT_MS = 10_000;

/**
 * Recall takes the closest hits across every area and the route filters to one area afterwards,
 * so ask for as many as the service allows (its cap) to keep a same-area precedent from falling
 * outside the cut.
 */
export const SIMILAR_RECALL_K = 50;

export class RecallTimeoutError extends Error {
  constructor(ms: number) {
    super(`recall took longer than ${ms} ms`);
    this.name = "RecallTimeoutError";
  }
}

/**
 * Recallers for the promote panel's similar-precedents hint (T2.32), or null when Agent Memory
 * isn't configured. They use the API's own key (the write key, which also holds `memory:read`) in
 * each organization's scope. The hint is advisory: what comes back is filtered against the
 * registry by the route and never stored, and no plan is built from it. The planner is still the
 * only process whose recall feeds a plan.
 *
 * Recall makes a query and then one read per hit, each under the client's timeout, so the whole
 * call is also raced against `timeoutMs`. The client takes no abort signal, so reads still in
 * flight when the deadline passes run to their own timeout and are ignored.
 */
export function similarRecallerFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): SimilarRecallerFor | null {
  const config = memoryConfigFromEnv("write", env);
  if (config === null) return null;
  const { scope, ...client } = config;
  const timeoutMs = options.timeoutMs ?? SIMILAR_TIMEOUT_MS;
  const memory = new AgentMemoryClient({
    ...client,
    timeoutMs,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const byOrg = new Map<string, AgentMemoryPrecedents>();
  return (orgId) => {
    let precedents = byOrg.get(orgId);
    if (!precedents) {
      precedents = new AgentMemoryPrecedents(memory, {
        scope: precedentScope(scope, orgId),
        k: SIMILAR_RECALL_K,
      });
      byOrg.set(orgId, precedents);
    }
    const store = precedents;
    return { recall: (caseKey) => withDeadline(store.recall(caseKey), timeoutMs) };
  };
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RecallTimeoutError(ms)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
