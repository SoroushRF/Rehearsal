import type { BillingPolicy } from "@rehearsal/core";
import { createDb, loadRegistry, type PgBoss, startQueue } from "@rehearsal/db";
import policyV1 from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import policyV2 from "../../../scenarios/billing/policy.v2.json" with { type: "json" };
import policyV3 from "../../../scenarios/billing/policy.v3.json" with { type: "json" };
import { buildApp } from "./app";
import type { ApplyDeps } from "./apply";
import { bearerReviewer, clerkFromEnv, type ReviewerResolver } from "./auth";
import { publisherFromEnv, startPrecedentWorker } from "./precedent-sync";
import { tenantTokenDepsFromEnv } from "./tenant-tokens";

/** Without Clerk keys every command is refused as unauthenticated. */
const authenticate = clerkFromEnv();
if (!authenticate) console.warn("Clerk keys not set; every command will be refused (401)");
const reviewer: ReviewerResolver = authenticate ? bearerReviewer(authenticate) : () => null;

// The same policy files the executor loads, so approval and apply refuse what admission would refuse.
const policies = [policyV1, policyV2, policyV3] as BillingPolicy[];

/** Command routes need Postgres. Without it the API still starts in core mode and serves health. */
async function applyDeps(): Promise<ApplyDeps | undefined> {
  if (!process.env.DATABASE_URL) return undefined;
  try {
    return { db: createDb(), boss: await startQueue(), auth: reviewer, policies };
  } catch (err) {
    console.error("database unavailable; starting without command routes", err);
    return undefined;
  }
}

const apply = await applyDeps();
const boss: PgBoss | undefined = apply?.boss;
const plans = apply && { db: apply.db, auth: reviewer };
// The same policy file the executor loads, so approval refuses what admission would refuse.
const approvals = apply && {
  db: apply.db,
  reviewer,
  policies,
};
const runs = apply && { db: apply.db, auth: reviewer };
// Agent Memory is optional: without it a promotion is recorded and waits, and nothing plans from it.
const publisherFor = publisherFromEnv();
const precedents = apply && {
  db: apply.db,
  boss: apply.boss,
  reviewer,
  syncEnabled: publisherFor !== null,
};
if (apply && publisherFor) await startPrecedentWorker(apply.boss, { db: apply.db, publisherFor });
else if (apply) {
  console.warn("Agent Memory not configured; promoted precedents will wait for a sync");
}
const rehearse = apply && {
  db: apply.db,
  boss: apply.boss,
  reviewer,
  plannerSecret: process.env.PLANNER_WORKER_SECRET,
  precedentRegistry: async (orgId: string) => (await loadRegistry(apply.db, orgId)).snapshot,
};
const app = buildApp({
  apply,
  plans,
  approvals,
  runs,
  precedents,
  rehearse,
  reviewer,
  tenantTokens: tenantTokenDepsFromEnv(),
});
const port = Number(process.env.API_PORT ?? process.env.PORT ?? 3000);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => {
    await app.close();
    await boss?.stop();
    process.exit(0);
  });
}

app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
