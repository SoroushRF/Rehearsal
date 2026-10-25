import { readFileSync } from "node:fs";
import { PlanManifest, RehearsalScenarioRef } from "@rehearsal/contracts";
import { applyRehearsalChallenges } from "./challenge";

/**
 * Apply a scenario's before-run challenges to one rehearsal tenant.
 *
 * `pnpm rehearsal:challenge --rehearsal <id> --scenario phantom_membership --version 1 --plan plan.json`
 *
 * Timed edits and transport modes are printed as waiting. They are not applied early: a teammate
 * edit before the failed note would hold the note, and a fault body is never accepted here.
 */

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const rehearsalId = arg("rehearsal");
const scenarioId = arg("scenario");
const version = Number(arg("version"));
const planPath = arg("plan");
if (!rehearsalId || !scenarioId || !planPath || !Number.isInteger(version)) {
  console.error(
    "usage: rehearsal:challenge --rehearsal <id> --scenario <id> --version <n> --plan <file>",
  );
  process.exit(1);
}

const scenario = RehearsalScenarioRef.parse({ id: scenarioId, version });
const manifest = PlanManifest.parse(JSON.parse(readFileSync(planPath, "utf8")));
try {
  const result = await applyRehearsalChallenges({
    rehearsalId,
    manifest,
    scenario,
    phase: "before_run",
  });
  for (const line of result.applied) console.log(`ok  ${line}`);
  for (const line of result.waiting) console.log(`wait ${line}`);
  if (result.applied.length === 0 && result.waiting.length > 0) process.exitCode = 2;
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
