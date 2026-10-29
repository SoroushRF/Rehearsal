import { readFileSync } from "node:fs";
import { Gold } from "./schema";
import { type Split, splitRoot } from "./sets";

export { deriveGold, ORACLE_VERSION } from "./oracle";

/**
 * The only reader of held-out gold. Scoring code imports `@rehearsal/evals-held-out/gold`;
 * planner and baseline code must not (test/separation.test.ts checks the import graph).
 */

export function goldFile(setId: string, split: Split = "held-out"): URL {
  return new URL(`gold/${setId}.gold.json`, splitRoot(split));
}

export function loadGold(setId: string, split: Split = "held-out"): Gold {
  const gold = Gold.parse(JSON.parse(readFileSync(goldFile(setId, split), "utf8")));
  if (gold.set !== setId) throw new Error(`${setId}.gold.json names set ${gold.set}`);
  return gold;
}
