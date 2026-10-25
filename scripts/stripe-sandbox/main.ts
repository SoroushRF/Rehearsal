import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  checkSandbox,
  FIDELITY_LIMITS,
  type SandboxRun,
  sandboxClient,
  seedSandbox,
} from "./sandbox";

/**
 * `pnpm stripe:sandbox seed` creates one labelled run in the test-mode account and saves what it
 * created; `pnpm stripe:sandbox check [run.json]` reads it back and prints the report. Only
 * .env.stripe-sandbox is loaded: no Era, model or admin credential reaches this process.
 */

const ENV_FILE = new URL("../../.env.stripe-sandbox", import.meta.url);
const RUN_FILE = new URL("../../.stripe-sandbox-run.json", import.meta.url);

if (!existsSync(ENV_FILE)) {
  console.error(
    "No .env.stripe-sandbox. Create it with STRIPE_SANDBOX_SECRET_KEY=sk_test_… (see docs).",
  );
  process.exit(1);
}
process.loadEnvFile(ENV_FILE);
const client = sandboxClient();
const [command, file] = process.argv.slice(2);

if (command === "seed") {
  const run = await seedSandbox(client, randomBytes(6).toString("hex"));
  writeFileSync(RUN_FILE, `${JSON.stringify(run, null, 2)}\n`);
  console.log(
    `seeded run ${run.runId} in ${run.accountId}: ${run.chargeIds.length} charges, 1 refund`,
  );
} else if (command === "check") {
  const run = JSON.parse(readFileSync(file ?? RUN_FILE, "utf8")) as SandboxRun;
  const checks = await checkSandbox(client, run);
  const report = {
    evidence: "native_stripe_test",
    ranAt: new Date().toISOString(),
    runId: run.runId,
    account: run.accountId,
    apiVersion: process.env.STRIPE_SANDBOX_API_VERSION ?? "account default",
    checks,
    fidelityLimits: FIDELITY_LIMITS,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
} else {
  console.error("usage: pnpm stripe:sandbox seed | check [run.json]");
  process.exit(2);
}
