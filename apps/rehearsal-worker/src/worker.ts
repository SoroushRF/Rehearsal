import type { RehearsalEvidence, RehearsalVersions } from "@rehearsal/contracts";
import {
  type BillingPolicy,
  type Clock,
  createReadGuard,
  type ProviderPort,
  type WorldContext,
} from "@rehearsal/core";
import type { Db, Provisioning, RehearsalRunContext, RehearsalSweepContext } from "@rehearsal/db";
import {
  REHEARSAL_CHALLENGE_ROUTE,
  REHEARSAL_PROVISION_ROUTE,
  REHEARSAL_TEARDOWN_ROUTE,
  rehearsalOperatorPath,
  rehearsalWorkerViolations,
  rehearsalWorkerWorlds,
  STRIPE_CHARGE_PROJECTION,
  stripeReader,
  stripeWriter,
  withWriter,
  ZENDESK_TICKET_PROJECTION,
  zendeskReader,
  zendeskWriter,
} from "@rehearsal/providers";
import { z } from "zod";

/**
 * T3.16: the rehearsal worker (decision 0013 §3), the third worker role. It holds the rehearsal
 * worker secret and the rehearsal containers' URLs only. Each rehearsal's tokens are minted by the
 * operator for that rehearsal's `rh-<id>` tenant; provisioning and teardown are the operator's
 * (the API holds the admin token). No model, no grant, no operational world.
 */
export interface RehearsalWorkerConfig {
  db: Db;
  env: NodeJS.ProcessEnv;
  clock: Clock;
  policies: readonly BillingPolicy[];
  newId: (prefix: string) => string;
  versions: RehearsalVersions;
  evidence: RehearsalEvidence;
  fetch?: typeof fetch;
}

/** What the worker refuses to start with: forbidden credentials, or a missing URL or secret. */
export function rehearsalWorkerConfigViolations(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems = rehearsalWorkerViolations(env).map((k) => `must not hold ${k}`);
  for (const k of ["REHEARSAL_API_URL", "REHEARSAL_WORKER_SECRET", "DATABASE_URL"]) {
    if (!env[k]) problems.push(`needs ${k}`);
  }
  return problems;
}

export const workerVersions = (env: NodeJS.ProcessEnv): RehearsalVersions => ({
  commit: /^[0-9a-f]{7,40}$/.test(env.GIT_COMMIT ?? "") ? (env.GIT_COMMIT as string) : "0000000",
  engine: "executor@1",
  worker: "rehearsal-worker@0.0.0",
  verifier: "none",
  projections: { stripe: STRIPE_CHARGE_PROJECTION, zendesk: ZENDESK_TICKET_PROJECTION },
  images: {},
});

const ProvisionAnswer = z.union([
  z.object({ ok: z.literal(true), notFromEvidence: z.array(z.string()) }),
  z.object({ ok: z.literal(false), refusals: z.array(z.string()) }),
]);

/** Calls to the operator's routes, with the worker secret and the rehearsal's ID only. */
export function operatorClient(env: NodeJS.ProcessEnv, doFetch: typeof fetch = fetch) {
  const apiUrl = env.REHEARSAL_API_URL?.replace(/\/$/, "");
  const secret = env.REHEARSAL_WORKER_SECRET;
  if (!apiUrl || !secret) throw new Error("REHEARSAL_API_URL and REHEARSAL_WORKER_SECRET are set");
  const post = (route: string, id: string) =>
    doFetch(`${apiUrl}${rehearsalOperatorPath(route, id)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      redirect: "error",
    });
  return {
    async provision(rehearsalId: string): Promise<Provisioning> {
      const res = await post(REHEARSAL_PROVISION_ROUTE, rehearsalId);
      if (res.status !== 200 && res.status !== 422) {
        return { ok: false, refusals: [`operator provisioning answered ${res.status}`] };
      }
      return ProvisionAnswer.parse(await res.json());
    },
    async challenge(input: {
      rehearsalId: string;
      phase: "before_run" | "after_rejected";
      actionId?: string;
    }): Promise<{ applied: string[] }> {
      const res = await doFetch(
        `${apiUrl}${rehearsalOperatorPath(REHEARSAL_CHALLENGE_ROUTE, input.rehearsalId)}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
          body: JSON.stringify({
            phase: input.phase,
            ...(input.actionId ? { actionId: input.actionId } : {}),
          }),
          redirect: "error",
        },
      );
      if (res.status !== 200) throw new Error(`operator challenge answered ${res.status}`);
      return z.object({ applied: z.array(z.string()) }).parse(await res.json());
    },
    async teardown(rehearsalId: string): Promise<void> {
      const res = await post(REHEARSAL_TEARDOWN_ROUTE, rehearsalId);
      if (res.status !== 200) throw new Error(`operator teardown answered ${res.status}`);
    },
  };
}

/** Writers bound to one rehearsal's own tenants; their tokens are minted on first use. */
function bound(rehearsalId: string, config: RehearsalWorkerConfig) {
  const worlds = rehearsalWorkerWorlds(rehearsalId, config.env, {
    clock: config.clock,
    fetch: config.fetch,
  });
  const target = (vendor: "stripe" | "zendesk") => ({
    world: "rehearsal" as const,
    config: worlds[vendor],
    authorization:
      vendor === "stripe" ? "Bearer sk_test_rehearsal_worker" : "Bearer rehearsal-worker",
  });
  const providers: Partial<Record<"stripe" | "zendesk", ProviderPort>> = {
    // Readers too: the step guard re-reads each write's evidence in this tenant first.
    stripe: withWriter(
      stripeReader({ ...target("stripe"), clock: config.clock }),
      stripeWriter(target("stripe")),
    ),
    zendesk: withWriter(
      zendeskReader({ ...target("zendesk"), clock: config.clock }),
      zendeskWriter(target("zendesk")),
    ),
  };
  const contexts: Partial<Record<"stripe" | "zendesk", WorldContext>> = {
    stripe: { world: "rehearsal", tenant: worlds.stripe.tenant },
    zendesk: { world: "rehearsal", tenant: worlds.zendesk.tenant },
  };
  return { providers, worlds: contexts };
}

/** The run context for one rehearsal job. */
export function runContext(
  rehearsalId: string,
  config: RehearsalWorkerConfig,
): RehearsalRunContext {
  const operator = operatorClient(config.env, config.fetch);
  const tenant = bound(rehearsalId, config);
  return {
    db: config.db,
    ...tenant,
    clock: config.clock,
    policies: config.policies,
    newId: config.newId,
    versions: config.versions,
    evidence: config.evidence,
    provision: (_manifest, id) => operator.provision(id),
    teardown: (id) => operator.teardown(id),
    challenge: (input) => operator.challenge(input),
    guard: createReadGuard({ ...tenant, clock: config.clock }),
  };
}

/** One sweep's context: reads go to each rehearsal's own tenant, resets to the operator. */
export function sweepContext(
  config: RehearsalWorkerConfig,
  opts: { now: Date; leaseMs: number; handOffAfterMs: number; onHandOff?: (ids: string[]) => void },
): RehearsalSweepContext {
  const operator = operatorClient(config.env, config.fetch);
  return {
    db: config.db,
    ...opts,
    readers: async (id) => bound(id, config),
    teardown: (id) => operator.teardown(id),
    clock: config.clock,
    policies: config.policies,
    newId: config.newId,
    versions: config.versions,
    evidence: config.evidence,
  };
}
