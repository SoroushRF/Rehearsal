import type { Receipt, RunEvent } from "@rehearsal/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunReport } from "../src/components/RunTimeline";
import { fixtureBundles } from "../src/fixtures";
import { describeEvent, explainReceipt, latestReceipts, type RunView } from "../src/runs";

const HASH = "a".repeat(64);
const manifest = fixtureBundles[0]?.bundle.manifest ?? expect.unreachable();

const receipt = (actionId: string, over: Partial<Receipt>): Receipt => ({
  id: `rcpt_${actionId}`,
  actionId,
  planHash: HASH,
  approvalId: "grant_1",
  outcome: "confirmed",
  providerRef: null,
  observedEffect: {},
  protection: "native_guard_with_documented_limits",
  holdReason: null,
  limitations: [],
  recordedAt: "2026-10-22T12:00:00.000Z",
  ...over,
});

let seq = 0;
const event = (type: string, payload: unknown): RunEvent => ({
  seq: ++seq,
  runId: "run_1",
  type,
  at: "2026-10-22T12:00:00.000Z",
  payload,
});

const run = (state: RunView["state"]): RunView => ({
  id: "run_1",
  planId: manifest.planId,
  revision: 1,
  planHash: HASH,
  approvalId: "grant_1",
  requestedBy: "user_1",
  state,
  createdAt: "2026-10-22T12:00:00.000Z",
  updatedAt: "2026-10-22T12:00:01.000Z",
});

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'");

describe("a phantom run reads clearly", () => {
  const events = [
    event("run.admitted", { approvalId: "grant_1" }),
    event(
      "step.receipt",
      receipt("refund_001", { providerRef: { vendor: "stripe", kind: "refund", id: "re_1" } }),
    ),
    event(
      "step.receipt",
      receipt("refund_002", {
        outcome: "held",
        holdReason: {
          kind: "query_membership_changed",
          queryObservationId: "q_charges_002",
          added: ["ch_new_dup"],
          removed: [],
        },
      }),
    ),
    event(
      "step.receipt",
      receipt("note_002", {
        outcome: "skipped_dependency",
        holdReason: { kind: "predecessor_not_confirmed", stepId: "refund_002" },
      }),
    ),
    event("run.finished", { state: "partial", error: null }),
  ];
  const html = text(
    renderToStaticMarkup(<RunReport run={run("partial")} events={events} manifest={manifest} />),
  );

  it("says what was held, what appeared, and why", () => {
    expect(html).toContain(
      "New matching record appeared after approval (ch_new_dup). The approved plan didn't account for it, so this step waits for a new plan.",
    );
    expect(html).toContain("Waits for refund_002, which didn't complete.");
    expect(html).toContain("Applied (refund re_1).");
    expect(html).not.toContain("read back");
  });

  it("summarizes outcomes and marks steps never reached", () => {
    expect(html).toContain("1 done · 1 held · 1 skipped");
    expect(html).toContain("no receipt");
  });
});

describe("a teammate-conflict run reads clearly", () => {
  it("says the teammate's edit was kept", () => {
    const events = [
      event("step.receipt", receipt("patch_002", { outcome: "compensation_conflict" })),
      event("step.receipt", receipt("patch_001", { outcome: "compensated" })),
    ];
    const html = text(
      renderToStaticMarkup(<RunReport run={run("failed")} events={events} manifest={manifest} />),
    );
    expect(html).toContain(
      "Not undone: someone changed the field after we wrote it, so their edit was kept.",
    );
    expect(html).toContain("Undone: the field still held the value we wrote, so it was restored.");
  });
});

describe("run log", () => {
  it("keeps the latest receipt per action", () => {
    const later = receipt("refund_001", { id: "rcpt_2", outcome: "confirmed" });
    const map = latestReceipts([
      event("step.receipt", receipt("refund_001", { outcome: "unknown_outcome" })),
      event("step.receipt", later),
      event("step.receipt", { not: "a receipt" }),
    ]);
    expect([...map.values()]).toEqual([later]);
  });

  it.each([
    [
      event("step.retry", { actionId: "refund_001", status: 429, delayMs: 250 }),
      "refund_001: provider answered 429; sending the same bytes again in 250 ms.",
    ],
    [event("run.refused", { detail: "grant expired" }), "Refused before any step: grant expired."],
    [
      event("run.needs_operator", { state: "applying", reaps: 12 }),
      "Stuck: automatic retries are exhausted. An operator needs to look at this run.",
    ],
    [
      event("run.reaped", { state: "applying" }),
      "Re-queued: the run had stalled with no job running, so it was picked up again.",
    ],
    [event("something.new", {}), "something.new"],
  ])("describes %j", (e, line) => {
    expect(describeEvent(e)).toBe(line);
  });
});

describe("a confirmed receipt claims a read-back only when one happened", () => {
  const confirmed = (limitations: string[]) =>
    explainReceipt(
      receipt("refund_001", {
        providerRef: { vendor: "stripe", kind: "refund", id: "re_1" },
        limitations,
      }),
    );

  // The executor's limitation lines (packages/core/src/executor.ts), one per confirmed path.
  it.each([
    ["read back after the write", "read back from the provider after the write"],
    [
      "reconciled from a lost response",
      "outcome of attempt att_1 (key op_1) found by reading the provider; not re-sent",
    ],
    [
      "resolved by another revision's run",
      "applied by attempt att_1, resolved by another revision's run; read back, not re-sent",
    ],
    [
      "an earlier revision's unconfirmed write",
      `applied by attempt att_1 under plan hash ${HASH}; read back, not re-sent`,
    ],
  ])("says read back when %s", (_, line) => {
    expect(confirmed([line, "retried 2 times"])).toBe("Applied and read back (refund re_1).");
  });

  it.each([
    [
      "adopted from an earlier revision",
      `applied by attempt att_1 under plan hash ${HASH}; not re-sent`,
    ],
    [
      "recorded before read-backs existed",
      "effect taken from the write response; no read-back yet",
    ],
  ])("says only applied when %s", (_, line) => {
    expect(confirmed([line])).toBe("Applied (refund re_1).");
  });

  it("says the read-back was inconclusive when it was", () => {
    expect(
      confirmed(["effect taken from the write response; read-back inconclusive: read failed"]),
    ).toBe("Applied: the provider confirmed the write, but reading it back was inconclusive.");
  });

  it("drops the reference when there is none", () => {
    expect(explainReceipt(receipt("note_001", {}))).toBe("Applied.");
    expect(
      explainReceipt(
        receipt("note_001", { limitations: ["read back from the provider after the write"] }),
      ),
    ).toBe("Applied and read back.");
  });
});
