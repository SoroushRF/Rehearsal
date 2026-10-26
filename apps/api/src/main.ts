import type { BillingPolicy } from "@rehearsal/core";
import { createDb, loadRegistry, type PgBoss, startQueue } from "@rehearsal/db";
import { iamClientViolations } from "@rehearsal/iam/boot";
import policyV1 from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import policyV2 from "../../../scenarios/billing/policy.v2.json" with { type: "json" };
import policyV3 from "../../../scenarios/billing/policy.v3.json" with { type: "json" };
import { buildApp } from "./app";
import type { ApplyDeps } from "./apply";
import { iamClientFromEnv } from "./iam";
import { ensureOrgSeeded, workerHasWork } from "./org-worlds";
import { publisherFromEnv, startPrecedentWorker } from "./precedent-sync";
import { rehearsalTenantActive } from "./rehearsal-operator";
import { rehearsalTokenDepsFromEnv } from "./rehearsal-tokens";
import { tenantTokenDepsFromEnv } from "./tenant-tokens";

/**
 * The API is one of the two clients IAM trusts. Without its client certificate it does not boot,
 * so it cannot ask over an open connection. Person routes send the session token to IAM; this
 * process does not hold the Clerk secret.
 */
const iamCerts = iamClientViolations();
if (iamCerts.length > 0) {
  console.error(`api needs its IAM client certificate: ${iamCerts.join(", ")}`);
  process.exit(1);
}
const iam = iamClientFromEnv();
if (!iam) {
  console.error("api needs IAM_URL and its client certificate to ask IAM");
  process.exit(1);
}

// The same policy files the executor loads, so approval and apply refuse what admission would refuse.
const policies = [policyV1, policyV2, policyV3] as BillingPolicy[];

/** Command routes need Postgres. Without it the API still starts in core mode and serves health. */
async function applyDeps(): Promise<ApplyDeps | undefined> {
  if (!process.env.DATABASE_URL) return undefined;
  try {
    return { db: createDb(), boss: await startQueue(), iam, policies };
  } catch (err) {
    console.error("database unavailable; starting without command routes", err);
    return undefined;
  }
}

const apply = await applyDeps();
const boss: PgBoss | undefined = apply?.boss;
const plans = apply && { db: apply.db, iam };
// The same policy file the executor loads, so approval refuses what admission would refuse.
const approvals = apply && {
  db: apply.db,
  iam,
  policies,
};
const runs = apply && { db: apply.db, iam };
// Live demo (#330): the company overview reads the operational world with the API's admin token.
// Each org reads its own operational tenant, seeded with the demo cohort on first use.
const tenantTokens = tenantTokenDepsFromEnv();
const company = apply && {
  db: apply.db,
  iam,
  ensureSeeded: (orgId: string) => ensureOrgSeeded(orgId),
};
// Agent Memory is optional: without it a promotion is recorded and waits, and nothing plans from it.
const publisherFor = publisherFromEnv();
const precedents = apply && {
  db: apply.db,
  boss: apply.boss,
  iam,
  syncEnabled: publisherFor !== null,
};
if (apply && publisherFor) await startPrecedentWorker(apply.boss, { db: apply.db, publisherFor });
else if (apply) {
  console.warn("Agent Memory not configured; promoted precedents will wait for a sync");
}
const rehearse = apply && {
  db: apply.db,
  boss: apply.boss,
  iam,
  plannerSecret: process.env.PLANNER_WORKER_SECRET,
  precedentRegistry: async (orgId: string) => (await loadRegistry(apply.db, orgId)).snapshot,
  // Each org plans in its own tenant (#330): seed it before the first plan job.
  ensureSeeded: (orgId: string) => ensureOrgSeeded(orgId),
};
const executionRehearsals = apply && { db: apply.db, boss: apply.boss, iam };
// T1.23/T3.16: the rehearsal worker's minter and operator routes, when this API holds the rehearsal
// admin token and worker secret. A token is minted only for a claimed rehearsal not yet reset.
const rehearsalTokens =
  apply && rehearsalTokenDepsFromEnv((id) => rehearsalTenantActive(apply.db, id));
const rehearsalOperator = apply &&
  rehearsalTokens && { db: apply.db, secret: rehearsalTokens.secret };
const app = buildApp({
  apply,
  plans,
  approvals,
  runs,
  company,
  precedents,
  rehearse,
  executionRehearsals,
  iam,
  tenantTokens: tenantTokens && {
    ...tenantTokens,
    // A worker gets an org's tenant only while its own queue has that org's job (#330).
    ...(apply && { hasWork: (role, orgId) => workerHasWork(apply.db, role, orgId) }),
  },
  rehearsalTokens,
  rehearsalOperator,
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
