import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CATALOG_SEED, catalogFiles, deriveSeed, generateCatalog, serialize } from "../src/catalog";
import { Manifest, planRuns } from "../src/run-plan";
import { splitRoot } from "../src/sets";

/**
 * T1.40: the committed catalog is exactly what its seed generates, covers 100–200 behaviorally
 * distinct configurations across the families the issue names, and the run plan selects, repeats
 * and reproduces attempts deterministically.
 */

const manifest = Manifest.parse(
  JSON.parse(readFileSync(new URL("manifest.json", splitRoot("catalog")), "utf8")),
);

describe("scenario catalog", () => {
  it("is what the seed generates, byte for byte", () => {
    for (const file of catalogFiles()) {
      expect(
        readFileSync(file.url, "utf8"),
        `${file.url.pathname} is stale; run pnpm eval:catalog write`,
      ).toBe(serialize(file.value));
    }
  });

  it("generates the same catalog every time, and a different one from another seed", () => {
    expect(generateCatalog()).toEqual(generateCatalog());
    expect(generateCatalog(CATALOG_SEED + 1)[0]?.incident).not.toEqual(
      generateCatalog()[0]?.incident,
    );
  });

  it("has 100–200 configurations, none behaviorally the same as another", () => {
    const configs = manifest.configurations;
    expect(configs.length).toBeGreaterThanOrEqual(100);
    expect(configs.length).toBeLessThanOrEqual(200);
    expect(new Set(configs.map((c) => c.id)).size).toBe(configs.length);
    expect(new Set(configs.map((c) => c.signature)).size).toBe(configs.length);
    expect(new Set(configs.map((c) => c.incident)).size).toBeGreaterThanOrEqual(8);
  });

  it("covers every family the issue names, in every incident", () => {
    const families = [
      "baseline",
      "scoped",
      "relevant_drift",
      "benign_drift",
      "teammate_edit",
      "existing_remedy",
      "incomplete_read",
      "lost_response",
      "combination",
    ];
    for (const incident of new Set(manifest.configurations.map((c) => c.incident))) {
      const mine = manifest.configurations.filter((c) => c.incident === incident);
      expect(new Set(mine.map((c) => c.family)), incident).toEqual(new Set(families));
    }
    // Combinations stay bounded.
    for (const c of manifest.configurations) expect(c.perturbations.length).toBeLessThanOrEqual(3);
  });

  it("gives each configuration its own seed, derived from the catalog seed", () => {
    for (const c of manifest.configurations) {
      expect(c.seed).toBe(deriveSeed(manifest.generator.seed, c.id));
    }
  });
});

describe("run plan", () => {
  it("runs every configuration in the three modes once by default, counted apart", () => {
    const plan = planRuns(manifest);
    expect(plan.modes).toEqual(["direct", "per_call", "rehearsal"]);
    expect(plan.planner).toEqual({ kind: "scripted" });
    expect(plan.counts).toEqual({
      incidents: 8,
      configurations: manifest.configurations.length,
      modeExecutions: manifest.configurations.length * 3,
      attempts: manifest.configurations.length * 3,
    });
  });

  it("selects by ID, set and family, and repeats with a seed per attempt", () => {
    const plan = planRuns(manifest, {
      sets: ["g02"],
      families: ["lost_response"],
      modes: ["rehearsal", "competent"],
      repeat: 3,
    });
    expect(new Set(plan.attempts.map((a) => a.config))).toEqual(
      new Set(["G02-14", "G02-15", "G02-16"]),
    );
    expect(plan.counts).toEqual({
      incidents: 1,
      configurations: 3,
      modeExecutions: 6,
      attempts: 18,
    });
    expect(new Set(plan.attempts.map((a) => a.seed)).size).toBe(18);
    expect(() => planRuns(manifest, { only: ["G99-1"] })).toThrow("no configuration G99-1");
    expect(() => planRuns(manifest, { repeat: 0 })).toThrow("--repeat");
  });

  it("reproduces one attempt with the same seed it had in the full plan", () => {
    const full = planRuns(manifest, { only: ["G05-13"], repeat: 4 });
    const failed = full.attempts.find((a) => a.mode === "per_call" && a.attempt === 3);
    expect(failed?.repro).toBe("pnpm eval:catalog plan --only G05-13 --modes per_call --attempt 3");
    const again = planRuns(manifest, { only: ["G05-13"], modes: ["per_call"], attempt: 3 });
    expect(again.attempts).toEqual([failed]);
  });

  it("plans real-model attempts only within an explicit budget", () => {
    const planner = { kind: "model" as const, model: "claude-sonnet-5-5", maxAttempts: 10 };
    expect(() => planRuns(manifest, { sets: ["g01"], planner })).toThrow(
      "exceed --max-attempts 10",
    );
    const plan = planRuns(manifest, { only: ["G01-1"], modes: ["rehearsal"], planner });
    expect(plan.attempts[0]?.repro).toContain("--planner model --model claude-sonnet-5-5");
  });
});
