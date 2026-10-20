import { eraMeta, resolveWorld } from "@rehearsal/providers";

/**
 * Day-one gate, step 1: every world is up, reachable and writable.
 * Run after `pnpm infra:up`. Exits non-zero on any failure.
 */
const targets = [
  ["stripe", "planning"],
  ["stripe", "operational"],
  ["zendesk", "planning"],
  ["zendesk", "operational"],
] as const;

let failed = false;
for (const [vendor, world] of targets) {
  try {
    const cfg = resolveWorld(vendor, world);
    const meta = await eraMeta(cfg);
    const writable = meta.writes?.allowed === true;
    console.log(
      `${writable ? "ok  " : "FAIL"} ${vendor}/${world} ${cfg.baseUrl} writes=${writable}`,
    );
    if (!writable) failed = true;
  } catch (e) {
    console.log(`FAIL ${vendor}/${world}: ${(e as Error).message}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
