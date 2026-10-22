import { readdirSync, readFileSync } from "node:fs";
import { PlanManifest } from "@rehearsal/contracts";
import { createDb, migrateDb } from "@rehearsal/db";
import { storePlan } from "../src/plans";

/**
 * Stores the shared fixture plans (revision 1) for one Clerk organization, so the review page has
 * something to show before the planner worker stores real plans. They keep their "fixture" planner
 * label, and the UI marks them as fixtures.
 *
 *   pnpm --filter @rehearsal/api seed:plans org_2abc…
 */
const orgId = process.argv[2];
if (!orgId?.startsWith("org_")) {
  console.error("usage: seed:plans <clerk organization ID, e.g. org_2abc…>");
  process.exit(1);
}

const cases = new URL("../../../scenarios/billing/cases/", import.meta.url);
const db = createDb();
await migrateDb(db);
for (const file of readdirSync(cases).filter((f) => f.endsWith(".bundle.json"))) {
  const { bundle } = JSON.parse(readFileSync(new URL(file, cases), "utf8"));
  const manifest = PlanManifest.parse({ ...bundle.manifest, orgId });
  const stored = await storePlan(db, manifest);
  console.log(
    stored
      ? `stored ${manifest.planId} r1 ${stored.planHash}`
      : `${manifest.planId} r1 already stored`,
  );
}
await db.$client.end();
