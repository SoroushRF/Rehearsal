import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CATALOG_SEED, catalogFiles, serialize } from "./catalog";
import { Manifest, MODES, type Mode, planRuns, type Selection } from "./run-plan";
import { splitRoot } from "./sets";

/**
 * `pnpm eval:catalog <command>` (T1.40):
 *   write                        regenerate the committed catalog from its seed
 *   plan [options]               list the attempts a run would make, each with its repro command
 *     --only G01-3,G04-12        configurations by ID
 *     --set g01,g02              configurations of some sets
 *     --family lost_response     configurations of some families
 *     --modes direct,rehearsal   modes (default direct,per_call,rehearsal; competent is opt-in)
 *     --repeat <n>               attempts per configuration and mode (default 1)
 *     --attempt <n>              plan only attempt n, to reproduce one failure
 *     --planner model --model <id> --max-attempts <n>
 *                                plan real-model attempts; refuses more than the budget
 *     --out <path>               write the plan as JSON (default: print a summary)
 * The plan doesn't run anything. Running it is the held-out runner's job (T1.35), on Era, against
 * the submission commit.
 */

const [command, ...rest] = process.argv.slice(2);
const list = (v?: string) =>
  v
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

if (command === "write") {
  const { values } = parseArgs({ args: rest, options: { seed: { type: "string" } } });
  const seed = values.seed ? Number(values.seed) : CATALOG_SEED;
  if (seed !== CATALOG_SEED) {
    throw new Error(`the committed catalog uses seed ${CATALOG_SEED}; a new seed is a new version`);
  }
  for (const file of catalogFiles(seed)) {
    mkdirSync(dirname(fileURLToPath(file.url)), { recursive: true });
    writeFileSync(file.url, serialize(file.value));
  }
  console.log(`wrote the catalog (seed ${seed}) to ${fileURLToPath(splitRoot("catalog"))}`);
} else if (command === "plan") {
  const { values } = parseArgs({
    args: rest,
    options: {
      only: { type: "string" },
      set: { type: "string" },
      family: { type: "string" },
      modes: { type: "string" },
      repeat: { type: "string" },
      attempt: { type: "string" },
      planner: { type: "string", default: "scripted" },
      model: { type: "string" },
      "max-attempts": { type: "string" },
      out: { type: "string" },
    },
  });
  const modes = list(values.modes);
  for (const m of modes ?? []) {
    if (!(MODES as readonly string[]).includes(m)) throw new Error(`unknown mode ${m}`);
  }
  let planner: Selection["planner"];
  if (values.planner === "model") {
    const maxAttempts = Number(values["max-attempts"]);
    if (!values.model || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error("--planner model needs --model and a --max-attempts budget");
    }
    planner = { kind: "model", model: values.model, maxAttempts };
  } else if (values.planner !== "scripted") {
    throw new Error(`--planner is scripted or model: ${values.planner}`);
  }
  const manifest = Manifest.parse(
    JSON.parse(readFileSync(new URL("manifest.json", splitRoot("catalog")), "utf8")),
  );
  const plan = planRuns(manifest, {
    only: list(values.only),
    sets: list(values.set),
    families: list(values.family),
    modes: modes as Mode[] | undefined,
    repeat: values.repeat ? Number(values.repeat) : undefined,
    attempt: values.attempt ? Number(values.attempt) : undefined,
    planner,
  });
  if (values.out) {
    mkdirSync(dirname(values.out), { recursive: true });
    writeFileSync(values.out, serialize(plan));
  }
  const { counts } = plan;
  console.log(
    `${counts.incidents} incidents, ${counts.configurations} configurations, ${counts.modeExecutions} mode executions, ${counts.attempts} attempts (${plan.planner.kind} planner)`,
  );
  if (!values.out) for (const a of plan.attempts.slice(0, 20)) console.log(`  ${a.repro}`);
  if (!values.out && plan.attempts.length > 20)
    console.log(`  … ${plan.attempts.length - 20} more`);
} else {
  console.error("usage: pnpm eval:catalog write | plan [--only …] [--modes …] [--repeat n]");
  process.exit(1);
}
