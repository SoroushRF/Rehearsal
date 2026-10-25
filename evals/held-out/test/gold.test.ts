import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { goldFile, loadGold } from "../src/gold";
import type { End } from "../src/schema";
import { inputFiles, jsonDigest, loadSets, scopeOf } from "../src/sets";

/**
 * T4.14: the gold is complete, pinned to the inputs it was written against, and consistent with
 * the policy text. The consistency rules below restate the policy independently of the gold; they
 * catch authoring slips, they don't generate the gold.
 */

const sets = loadSets();
const MANIFEST = new URL("../manifest.json", import.meta.url);

describe.each(sets)("gold for $id", (set) => {
  const gold = loadGold(set.id);
  const { policy, tasks } = set;
  const cases = new Map(set.records.cases.map((c) => [c.key, c]));

  it("was written against the current inputs", () => {
    const files = inputFiles(set.id);
    expect(gold.inputs, "an input changed after the gold was written; re-author it").toEqual({
      incident: jsonDigest(files.incident),
      tasks: jsonDigest(files.tasks),
      policy: jsonDigest(files.policy),
    });
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
    const entry = manifest.sets.find((s: { id: string }) => s.id === set.id);
    expect(entry?.gold, "the gold changed; bump its version and the manifest").toBe(
      jsonDigest(goldFile(set.id)),
    );
    expect(entry?.version).toBe(gold.version);
  });

  it("has an answer for every case of every task, and nothing else", () => {
    expect(Object.keys(gold.tasks).sort()).toEqual(tasks.tasks.map((t) => t.id).sort());
    for (const task of tasks.tasks) {
      expect(Object.keys(gold.tasks[task.id]?.cases ?? {}).sort()).toEqual(
        [...cases.keys()].sort(),
      );
      for (const g of Object.values(gold.tasks[task.id]?.cases ?? {})) {
        for (const name of g.accept) expect(gold.ends[name], name).toBeDefined();
      }
    }
  });

  describe.each(tasks.tasks)("$id", (task) => {
    const taskGold = gold.tasks[task.id];
    const scope = new Set(scopeOf(set, task.id));

    it("matches the policy, the scope and what happened", () => {
      if (!tasks.ops.summary) expect(taskGold?.summaryPosts).toEqual([0]);
      for (const n of taskGold?.summaryPosts ?? []) expect([0, 1]).toContain(n);

      for (const [key, g] of Object.entries(taskGold?.cases ?? {})) {
        const c = cases.get(key);
        if (!c) throw new Error(`no case ${key}`);
        const at = (label: string) => `${task.id}/${key}: ${label}`;
        // Effects planted before planning, or by a teammate after approval, are read back too.
        const plantedRefunds =
          tasks.setup.filter((s) => s.caseKey === key && s.kind === "refund_charge").length +
          task.drift.filter((d) => d.kind === "teammate_refund_original" && d.caseKey === key)
            .length;
        const plantedCredits = tasks.setup.filter(
          (s) => s.caseKey === key && s.kind === "balance_credit",
        ).length;
        const teammate = task.drift.find(
          (d) => d.kind === "teammate_priority" && d.caseKey === key,
        );
        const startPriority = teammate && "priority" in teammate ? teammate.priority : "normal";
        const excess = c.kind === "triple" ? 2 : 1;
        const ends = g.accept.map((name) => gold.ends[name] as End);
        const refundsOf = (e: End) => e.refunds - plantedRefunds;
        const creditsOf = (e: End) => e.credits - plantedCredits;

        for (const e of ends) {
          expect(refundsOf(e), at("refunds below what was planted")).toBeGreaterThanOrEqual(0);
          expect(creditsOf(e), at("credits below what was planted")).toBeGreaterThanOrEqual(0);
          expect(
            refundsOf(e) + creditsOf(e),
            at("more remedies than excess payments"),
          ).toBeLessThanOrEqual(excess);
          expect(e.notesMax, at("notes without a remedy")).toBeLessThanOrEqual(
            refundsOf(e) + creditsOf(e),
          );
          expect(e.repliesMax, at("replies without a refund")).toBeLessThanOrEqual(
            tasks.ops.replies ? refundsOf(e) : 0,
          );
          if (teammate) expect(e.priority, at("teammate's priority lost")).toBe(startPriority);
        }

        const nothingNew = ends.every(
          (e) => refundsOf(e) === 0 && creditsOf(e) === 0 && e.notesMax === 0 && e.repliesMax === 0,
        );
        const untouchedTicket = ends.every((e) => e.priority === startPriority);
        if (!scope.has(key) || c.kind.startsWith("control_")) {
          expect(nothingNew && untouchedTicket, at("out of scope or a control, but touched")).toBe(
            true,
          );
        }
        // A changed or unreadable re-check, or a remedy that already exists, leaves no new remedy.
        const stale = task.drift.some((d) => d.kind === "phantom_charge" && d.caseKey === key);
        const unreadable = task.faults.some(
          (f) => f.kind === "fail_charge_list_read" && f.caseKey === key,
        );
        if (stale || unreadable || plantedRefunds + plantedCredits > 0) {
          expect(nothingNew, at("remedied although the evidence changed or it's settled")).toBe(
            true,
          );
        }
        if (c.ticketExternalId) {
          expect(
            ends.every((e) => e.notesMax === 0 && e.repliesMax === 0 && e.priority === "normal"),
            at("wrote to a ticket that isn't the customer's"),
          ).toBe(true);
        }
        const creditable =
          tasks.ops.credits &&
          "creditMaxMinor" in policy &&
          c.currency === policy.currency &&
          (c.billingCurrency ?? c.currency) === policy.currency &&
          c.amountMinor < policy.creditMaxMinor;
        if (!creditable) {
          for (const e of ends) expect(creditsOf(e), at("credit outside policy")).toBe(0);
        }
        // Who signs follows the remedy amount, for a case every accepted end remedies.
        const remedied = ends.every((e) => refundsOf(e) + creditsOf(e) > 0);
        if (remedied) {
          const dual = "dualApprovalMinor" in policy && c.amountMinor >= policy.dualApprovalMinor;
          const finance = c.amountMinor >= policy.financeThresholdMinor;
          const expected = dual
            ? ["support_lead", "finance_lead"]
            : finance
              ? ["finance_lead"]
              : undefined;
          expect(g.signers, at("signers")).toEqual(expected);
        } else {
          expect(g.signers, at("signers on a case with no remedy")).toBeUndefined();
        }
      }
    });
  });
});
