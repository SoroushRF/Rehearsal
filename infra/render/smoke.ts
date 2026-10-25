import { createDb } from "@rehearsal/db";
import { eraMeta, mintTenantToken } from "@rehearsal/providers";
import { sql } from "drizzle-orm";
import { iamClientFromEnv } from "../../apps/api/src/iam";
// @ts-expect-error deployment module is plain JavaScript
import { materializeEnv } from "./start.mjs";

// Run inside the API service shell. Does not reset a world, enqueue a job or spend model tokens.
Object.assign(process.env, materializeEnv("api"));
const env = process.env;
for (const world of ["PLANNING", "OPERATIONAL", "REHEARSAL"]) {
  for (const vendor of ["STRIPE", "ZENDESK", "SLACK"]) {
    const baseUrl = env[`ERA_${vendor}_${world}_URL`];
    if (!baseUrl) throw new Error(`missing ${vendor}/${world}`);
    const cfg = { baseUrl, tenant: env.ERA_TENANT ?? "rehearsal-demo" };
    const meta = await eraMeta(cfg);
    if (meta.writes?.allowed !== true) throw new Error(`${vendor}/${world} is not writable`);
    const admin = world === "REHEARSAL" ? env.REHEARSAL_ERA_ADMIN_TOKEN : env.ERA_ADMIN_TOKEN;
    if (!admin) throw new Error("missing operator credential");
    await mintTenantToken(cfg, admin);
    console.log(`ok ${vendor}/${world}: reachable, writable, token mint works`);
  }
}
const db = createDb();
await db.execute(sql`select 1`);
await db.$client.end();
console.log("ok Postgres");
const iam = iamClientFromEnv();
if (!iam || (await iam.identify("deployment-smoke-invalid-token")).kind !== "unauthenticated") {
  throw new Error("IAM mTLS unavailable or invalid token accepted");
}
console.log("ok IAM mTLS and unauthenticated refusal");
const origin = `https://${env.RENDER_EXTERNAL_HOSTNAME}`;
for (const path of ["/", "/app", "/api/health", "/replays/phantom.json"]) {
  const response = await fetch(`${origin}${path}`, {
    headers: { accept: path === "/" || path === "/app" ? "text/html" : "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  if (path.endsWith(".json")) await response.json();
  console.log(`ok public ${path}`);
}
const plans = await fetch(`${origin}/api/plans`, { signal: AbortSignal.timeout(30_000) });
if (plans.status !== 401)
  throw new Error(`signed-out plans returned ${plans.status}, expected 401`);
console.log("ok signed-out plans refused; deployment connectivity passed");
console.log(
  "Still required: each worker's ready log and a real plan → review → approve → apply run.",
);
