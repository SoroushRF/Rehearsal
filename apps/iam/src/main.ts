import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { iamServerViolations } from "./boot";
import { clerkFromEnv } from "./clerk";
import { loadRuleFiles } from "./rules";
import { createIamServer } from "./server";

/**
 * IAM listens only over mTLS. Without its server certificate and the client trust store it does
 * not boot, so it cannot fall back to an open port.
 */
const missing = iamServerViolations();
if (missing.length > 0) {
  console.error(`iam needs its server certificate and client trust: ${missing.join(", ")}`);
  process.exit(1);
}

const rulesDir =
  process.env.IAM_RULES_DIR ?? resolve(import.meta.dirname, "../../../scenarios/authz");
let files: ReturnType<typeof loadRuleFiles>;
try {
  files = loadRuleFiles(rulesDir);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const clerk = clerkFromEnv();
if (!clerk) console.warn("Clerk keys not set; every person question will be denied");

const cert = readFileSync(process.env.IAM_TLS_CERT ?? "");
const key = readFileSync(process.env.IAM_TLS_KEY ?? "");
const clientCa = readFileSync(process.env.IAM_TLS_CLIENT_CA ?? "");
const server = createIamServer({
  cert,
  key,
  clientCa,
  allowedClients: ["api", "executor"],
  files,
  clerk: clerk?.verifier ?? { verify: async () => null },
  orgs: clerk?.orgs,
});

const port = Number(process.env.IAM_PORT ?? 3443);
const host = process.env.IAM_HOST ?? "127.0.0.1";
server.listen(port, host, () => {
  console.log(
    `iam listening on https://${host}:${port} (${files.size} rule file${files.size === 1 ? "" : "s"})`,
  );
});
