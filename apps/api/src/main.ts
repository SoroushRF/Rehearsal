import type { BillingPolicyV1 } from "@rehearsal/core";
import { createDb, type PgBoss, startQueue } from "@rehearsal/db";
import policy from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import { buildApp } from "./app";
import type { ApplyDeps } from "./apply";
import { bearerReviewer, clerkFromEnv, type ReviewerResolver } from "./auth";
import { tenantTokenDepsFromEnv } from "./tenant-tokens";

/** Without Clerk keys every command is refused as unauthenticated. */
const authenticate = clerkFromEnv();
if (!authenticate) console.warn("Clerk keys not set; every command will be refused (401)");
const reviewer: ReviewerResolver = authenticate ? bearerReviewer(authenticate) : () => null;

/** Command routes need Postgres. Without it the API still starts in core mode and serves health. */
async function applyDeps(): Promise<ApplyDeps | undefined> {
  if (!process.env.DATABASE_URL) return undefined;
  try {
    return { db: createDb(), boss: await startQueue(), auth: reviewer };
  } catch (err) {
    console.error("database unavailable; starting without command routes", err);
    return undefined;
  }
}

const apply = await applyDeps();
const boss: PgBoss | undefined = apply?.boss;
const plans = apply && { db: apply.db, auth: reviewer };
// The same policy file the executor loads, so approval refuses what admission would refuse.
const approvals = apply && { db: apply.db, reviewer, policies: [policy as BillingPolicyV1] };
const runs = apply && { db: apply.db, auth: reviewer };
const app = buildApp({
  apply,
  plans,
  approvals,
  runs,
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
