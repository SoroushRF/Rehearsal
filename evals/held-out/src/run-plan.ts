import { z } from "zod";
import { deriveSeed } from "./catalog";

/**
 * T1.40: which catalog configurations to run, in which modes, how many times, and the command
 * that reproduces each attempt on its own. This plans runs; executing them is the held-out
 * runner's job (T1.35), against the submission commit.
 */

export const MODES = ["direct", "per_call", "rehearsal", "competent"] as const;
export type Mode = (typeof MODES)[number];
/** The comparison the issue asks for first; the competent script is added when asked for. */
export const DEFAULT_MODES: Mode[] = ["direct", "per_call", "rehearsal"];

const Configuration = z.object({
  id: z.string(),
  set: z.string(),
  seed: z.int(),
  incident: z.string(),
  family: z.string(),
  perturbations: z.array(z.string()),
  capabilities: z.array(z.string()),
  signature: z.string(),
});

export const Manifest = z.object({
  split: z.literal("catalog"),
  version: z.int().positive(),
  generator: z.object({ version: z.int().positive(), seed: z.int() }),
  oracle: z.object({ version: z.int().positive() }),
  configurations: z.array(Configuration),
});
export type Manifest = z.infer<typeof Manifest>;

export interface Selection {
  only?: string[];
  sets?: string[];
  families?: string[];
  modes?: Mode[];
  /** Attempts per configuration and mode. */
  repeat?: number;
  /** Plan a single attempt (1-based), to reproduce it. Overrides `repeat`. */
  attempt?: number;
  /** Scripted planning is the default; a real model is an explicit opt-in with a budget. */
  planner?: { kind: "scripted" } | { kind: "model"; model: string; maxAttempts: number };
}

export interface PlannedAttempt {
  config: string;
  set: string;
  incident: string;
  family: string;
  mode: Mode;
  attempt: number;
  /** For anything random in this attempt (fault timing, model sampling). Scripted runs ignore it. */
  seed: number;
  repro: string;
}

export interface RunPlan {
  catalog: { version: number; generator: number; seed: number; oracle: number };
  planner: NonNullable<Selection["planner"]>;
  modes: Mode[];
  /** Counted apart: correlated variations of one incident are not independent incidents. */
  counts: { incidents: number; configurations: number; modeExecutions: number; attempts: number };
  attempts: PlannedAttempt[];
}

export function planRuns(manifest: Manifest, sel: Selection = {}): RunPlan {
  const modes = sel.modes ?? DEFAULT_MODES;
  const planner = sel.planner ?? { kind: "scripted" as const };
  const configs = manifest.configurations.filter(
    (c) =>
      (!sel.only || sel.only.includes(c.id)) &&
      (!sel.sets || sel.sets.includes(c.set)) &&
      (!sel.families || sel.families.includes(c.family)),
  );
  const unknown = (sel.only ?? []).filter(
    (id) => !manifest.configurations.some((c) => c.id === id),
  );
  if (unknown.length > 0) throw new Error(`no configuration ${unknown.join(", ")} in the catalog`);
  if (configs.length === 0) throw new Error("the selection matches no configuration");

  const repeat = sel.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error(`--repeat must be ≥ 1: ${repeat}`);
  if (sel.attempt !== undefined && (!Number.isInteger(sel.attempt) || sel.attempt < 1)) {
    throw new Error(`--attempt must be ≥ 1: ${sel.attempt}`);
  }
  const numbers = sel.attempt ? [sel.attempt] : Array.from({ length: repeat }, (_, i) => i + 1);
  if (
    planner.kind === "model" &&
    configs.length * modes.length * numbers.length > planner.maxAttempts
  ) {
    throw new Error(
      `${configs.length * modes.length * numbers.length} model attempts exceed --max-attempts ${planner.maxAttempts}`,
    );
  }

  const seed = manifest.generator.seed;
  const plannerFlags =
    planner.kind === "model" ? ` --planner model --model ${planner.model} --max-attempts 1` : "";
  const attempts = configs.flatMap((c) =>
    modes.flatMap((mode) =>
      numbers.map((attempt) => ({
        config: c.id,
        set: c.set,
        incident: c.incident,
        family: c.family,
        mode,
        attempt,
        seed: deriveSeed(seed, c.id, mode, attempt),
        repro: `pnpm eval:catalog plan --only ${c.id} --modes ${mode} --attempt ${attempt}${plannerFlags}`,
      })),
    ),
  );
  return {
    catalog: {
      version: manifest.version,
      generator: manifest.generator.version,
      seed,
      oracle: manifest.oracle.version,
    },
    planner,
    modes,
    counts: {
      incidents: new Set(configs.map((c) => c.incident)).size,
      configurations: configs.length,
      modeExecutions: configs.length * modes.length,
      attempts: attempts.length,
    },
    attempts,
  };
}
