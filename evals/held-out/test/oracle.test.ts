import { describe, expect, it } from "vitest";
import { loadGold } from "../src/gold";
import { answerTask } from "../src/oracle";
import type { End } from "../src/schema";
import { loadSets } from "../src/sets";

/**
 * T1.40: the oracle that derives catalog gold reproduces the hand-authored held-out gold, case by
 * case: the same acceptable ends, the same ops that must not apply, the same signers. Tasks with
 * events (a withdrawn precedent) have no oracle rule and are skipped.
 */

const sortEnds = (ends: End[]) => ends.map((e) => JSON.stringify(e)).sort();
const sortOps = (ops: { op: string; cause: string }[]) =>
  ops.map((o) => `${o.op}:${o.cause}`).sort();

describe.each(loadSets())("oracle on $id", (set) => {
  const gold = loadGold(set.id);
  const tasks = set.tasks.tasks.filter((t) => t.events.length === 0);

  it.each(tasks)("agrees with the hand gold on $id", (task) => {
    const taskGold = gold.tasks[task.id];
    const answers = answerTask(set, task);
    expect(answers.summaryPosts, "summaryPosts").toEqual(taskGold?.summaryPosts);
    for (const c of set.records.cases) {
      const hand = taskGold?.cases[c.key];
      if (!hand) throw new Error(`${task.id}/${c.key}: no hand gold`);
      const derived = answers.cases.get(c.key);
      if (!derived) throw new Error(`${task.id}/${c.key}: no derived answer`);
      const at = `${task.id}/${c.key}`;
      expect(sortEnds(derived.accept), `${at} ends`).toEqual(
        sortEnds(hand.accept.map((n) => gold.ends[n] as End)),
      );
      expect(sortOps(derived.mustNotApply), `${at} mustNotApply`).toEqual(
        sortOps(hand.mustNotApply),
      );
      expect(derived.signers, `${at} signers`).toEqual(hand.signers);
    }
  });
});
