import { readFileSync } from "node:fs";
import { Gold } from "./schema";

/**
 * The only reader of held-out gold. Scoring code imports `@rehearsal/evals-held-out/gold`;
 * planner and baseline code must not (test/separation.test.ts checks the import graph).
 */

const GOLD = new URL("../gold/", import.meta.url);

export function goldFile(setId: string): URL {
  return new URL(`${setId}.gold.json`, GOLD);
}

export function loadGold(setId: string): Gold {
  const gold = Gold.parse(JSON.parse(readFileSync(goldFile(setId), "utf8")));
  if (gold.set !== setId) throw new Error(`${setId}.gold.json names set ${gold.set}`);
  return gold;
}
