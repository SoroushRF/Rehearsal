import { APPLY_QUEUE, APPLY_QUEUE_OPTIONS, createDb, startQueue } from "@rehearsal/db";
import {
  primeTokens,
  stripeReader,
  stripeWriter,
  withWriter,
  workerWorlds,
  zendeskReader,
  zendeskWriter,
} from "@rehearsal/providers";
import policy from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import { executorCredentialViolations } from "./credentials";
import { handleApplyJob, type WorkerContext } from "./worker";

/**
 * Executor worker: deterministic, no model key, no inference in the dispatch path.
 * Holds operational-world capability and consumes approved immutable manifests only.
 */
const forbidden = executorCredentialViolations();
if (forbidden.length > 0) {
  console.error(`executor-worker must not receive: ${forbidden.join(", ")}`);
  process.exit(1);
}

// Operational tenant tokens, minted by the operator and refreshed before expiry. Mint once at
// startup so a misconfigured minter fails here, not mid-apply.
const worlds = workerWorlds("executor");
await primeTokens(worlds);

// The simulators accept any bearer; real credentials would come from the environment here.
const target = (vendor: "stripe" | "zendesk") => ({
  world: "operational" as const,
  config: worlds[vendor],
  authorization:
    vendor === "stripe" ? "Bearer sk_test_rehearsal_executor" : "Bearer rehearsal-executor",
});
const clock = { now: () => new Date() }; // wall time: the reconcile window depends on it

const ctx: WorkerContext = {
  db: createDb(),
  providers: {
    stripe: withWriter(
      stripeReader({ ...target("stripe"), clock }),
      stripeWriter(target("stripe")),
    ),
    zendesk: withWriter(
      zendeskReader({ ...target("zendesk"), clock }),
      zendeskWriter(target("zendesk")),
    ),
  },
  worlds: {
    stripe: { world: "operational", tenant: worlds.stripe.tenant },
    zendesk: { world: "operational", tenant: worlds.zendesk.tenant },
  },
  clock,
  policies: [policy as WorkerContext["policies"][number]],
};

const boss = await startQueue();
// One job at a time per worker: a run holds its plan's lock, and runs of one plan serialize anyway.
await boss.work(APPLY_QUEUE, { batchSize: 1 }, async ([job]) => {
  if (!job) return;
  const result = await handleApplyJob(job.data, ctx, {
    retryCount: job.retryCount,
    retryLimit: APPLY_QUEUE_OPTIONS.retryLimit,
  });
  console.log(
    result.kind === "skipped"
      ? `job ${job.id} skipped: ${result.reason}`
      : `run ${result.outcome.state}${result.outcome.refusal ? ` (${result.outcome.refusal})` : ""}`,
  );
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => {
    // Let the active run finish (it is bounded by retries and timeouts); if it can't, the journal
    // keeps it safe and the job is retried.
    try {
      await boss.stop({ graceful: true, timeout: 120_000 });
    } catch (err) {
      console.error("pg-boss stop failed", err);
    }
    process.exit(0);
  });
}
console.log(
  `executor-worker consuming ${APPLY_QUEUE} (stripe=${worlds.stripe.baseUrl}, zendesk=${worlds.zendesk.baseUrl})`,
);
