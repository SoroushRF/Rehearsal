import { randomUUID } from "node:crypto";
import type { BillingPolicy } from "@rehearsal/core";
import { createDb, startQueue, sweepRehearsals, workRehearsalQueue } from "@rehearsal/db";
import policyV1 from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import policyV2 from "../../../scenarios/billing/policy.v2.json" with { type: "json" };
import policyV3 from "../../../scenarios/billing/policy.v3.json" with { type: "json" };
import {
  type RehearsalWorkerConfig,
  rehearsalWorkerConfigViolations,
  runContext,
  sweepContext,
  sweepTimings,
  workerVersions,
} from "./worker";

/**
 * Rehearsal worker (T3.16, decision 0013): consumes the `rehearsal` queue and sweeps rehearsals
 * whose worker stopped. Deterministic, no model key, rehearsal worlds only.
 */
const problems = rehearsalWorkerConfigViolations();
if (problems.length > 0) {
  console.error(`rehearsal-worker: ${problems.join(", ")}`);
  process.exit(1);
}

const config: RehearsalWorkerConfig = {
  db: createDb(),
  env: process.env,
  clock: { now: () => new Date() },
  policies: [policyV1, policyV2, policyV3] as BillingPolicy[],
  newId: (prefix) => `${prefix}_${randomUUID()}`,
  versions: workerVersions(process.env),
  evidence: "era_integration",
};

const boss = await startQueue();
await workRehearsalQueue(
  boss,
  async (job) => runContext(job.rehearsalId, config),
  (jobId, result) =>
    console.log(
      result.kind === "skipped"
        ? `rehearsal job ${jobId} skipped: ${result.reason}`
        : `rehearsal ${result.state}`,
    ),
);

// A rehearsal with no event for this long has lost its worker; it is failed, never resumed.
// Overridable for a recovery drill (the T4.13 gate kills a worker and waits for the sweep).
const { SWEEP_EVERY_MS, LEASE_MS, HAND_OFF_AFTER_MS } = sweepTimings(process.env);
let sweeping: Promise<void> = Promise.resolve();
const sweeper = setInterval(() => {
  sweeping = (async () => {
    try {
      const swept = await sweepRehearsals(
        sweepContext(config, {
          now: new Date(),
          leaseMs: LEASE_MS,
          handOffAfterMs: HAND_OFF_AFTER_MS,
          onHandOff: (ids) =>
            console.error(`rehearsals need an operator (outcome unknown): ${ids.join(", ")}`),
        }),
      );
      if (swept.expired.length > 0) console.log(`expired: ${swept.expired.join(", ")}`);
      if (swept.tornDown.length > 0) console.log(`torn down: ${swept.tornDown.join(", ")}`);
    } catch (err) {
      console.error("rehearsal sweep failed", err);
    }
  })();
}, SWEEP_EVERY_MS);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => {
    clearInterval(sweeper);
    await sweeping;
    try {
      await boss.stop({ graceful: true, timeout: 120_000 });
    } catch (err) {
      console.error("pg-boss stop failed", err);
    }
    process.exit(0);
  });
}
console.log("rehearsal-worker consuming rehearsal");
