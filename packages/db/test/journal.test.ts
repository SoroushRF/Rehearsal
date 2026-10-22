import { randomUUID } from "node:crypto";
import type { Attempt, Receipt } from "@rehearsal/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, isLegalTransition, JournalConflictError, migrateDb, PgJournal } from "../src";

const HASH = "a".repeat(64);
const BODY_HASH = "b".repeat(64);

function attempt(over: Partial<Attempt> = {}): Attempt {
  return {
    id: `att_${randomUUID()}`,
    actionId: "refund_001",
    planHash: HASH,
    operationKey: `op_${randomUUID()}`,
    attemptNo: 1,
    state: "prepared",
    request: {
      method: "POST",
      path: "/v1/refunds",
      encoding: "form",
      body: "charge=ch_1&amount=4210",
      bodySha256: BODY_HASH,
    },
    providerStatus: null,
    error: null,
    preparedAt: "2026-10-21T12:00:00.000Z",
    dispatchedAt: null,
    settledAt: null,
    ...over,
  };
}

describe("transition table", () => {
  it("allows the documented path and nothing else", () => {
    expect(isLegalTransition("prepared", "dispatched")).toBe(true);
    expect(isLegalTransition("dispatched", "unknown_outcome")).toBe(true);
    expect(isLegalTransition("unknown_outcome", "reconciled")).toBe(true);
    expect(isLegalTransition("prepared", "confirmed")).toBe(false);
    expect(isLegalTransition("confirmed", "dispatched")).toBe(false);
    expect(isLegalTransition("unknown_outcome", "dispatched")).toBe(false);
  });
});

// Needs a real Postgres: `pnpm infra:up` then `DB_TESTS=1 pnpm --filter @rehearsal/db test`.
describe.skipIf(!process.env.DB_TESTS)("PgJournal (real Postgres)", () => {
  const db = createDb(
    process.env.DATABASE_URL ?? "postgres://rehearsal:rehearsal@localhost:5432/rehearsal",
  );
  beforeAll(async () => {
    await migrateDb(db);
  });
  const journalFor = () => new PgJournal(db, `org_${randomUUID()}`);

  it("persists the exact request bytes before dispatch and reads them back", async () => {
    const journal = journalFor();
    const a = attempt();
    await journal.prepareAttempt(a);
    const [stored] = await journal.attemptsFor(a.planHash, a.actionId);
    expect(stored).toEqual(a);
  });

  it("walks prepared -> dispatched -> confirmed", async () => {
    const journal = journalFor();
    const a = attempt();
    await journal.prepareAttempt(a);
    const dispatched = await journal.transition(a.id, "prepared", "dispatched", {
      dispatchedAt: "2026-10-21T12:00:01.000Z",
    });
    expect(dispatched.state).toBe("dispatched");
    const confirmed = await journal.transition(a.id, "dispatched", "confirmed", {
      providerStatus: 200,
      settledAt: "2026-10-21T12:00:02.000Z",
    });
    expect(confirmed).toMatchObject({ state: "confirmed", providerStatus: 200 });
    expect(confirmed.dispatchedAt).toBe("2026-10-21T12:00:01.000Z");
  });

  it("lets only one of two racing workers advance an attempt", async () => {
    const journal = journalFor();
    const a = attempt();
    await journal.prepareAttempt(a);
    const results = await Promise.allSettled([
      journal.transition(a.id, "prepared", "dispatched"),
      journal.transition(a.id, "prepared", "dispatched"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected");
    expect(lost?.status === "rejected" && lost.reason).toBeInstanceOf(JournalConflictError);
  });

  it("refuses illegal transitions and a wrong `from` state", async () => {
    const journal = journalFor();
    const a = attempt();
    await journal.prepareAttempt(a);
    await expect(journal.transition(a.id, "prepared", "confirmed")).rejects.toThrow(
      JournalConflictError,
    );
    await expect(journal.transition(a.id, "dispatched", "confirmed")).rejects.toThrow(
      JournalConflictError,
    );
  });

  it("refuses a second attempt with the same operation key and number", async () => {
    const journal = journalFor();
    const a = attempt();
    await journal.prepareAttempt(a);
    await expect(
      journal.prepareAttempt(attempt({ operationKey: a.operationKey })),
    ).rejects.toThrow();
  });

  it("scopes everything to the organization", async () => {
    const mine = journalFor();
    const theirs = journalFor();
    const a = attempt();
    await mine.prepareAttempt(a);
    expect(await theirs.attemptsFor(a.planHash, a.actionId)).toEqual([]);
    await expect(theirs.transition(a.id, "prepared", "dispatched")).rejects.toThrow(
      JournalConflictError,
    );
  });

  it("binds a result once and rejects a different value", async () => {
    const journal = journalFor();
    const ref = { $ref: "result", stepId: "refund_001", path: "refund.id" } as const;
    await journal.bind({ planHash: HASH, ref, value: "re_1" });
    await journal.bind({ planHash: HASH, ref, value: "re_1" });
    await expect(journal.bind({ planHash: HASH, ref, value: "re_2" })).rejects.toThrow(
      JournalConflictError,
    );
    expect(await journal.bindings(HASH)).toEqual([{ planHash: HASH, ref, value: "re_1" }]);
  });

  it("records receipts and ordered run events", async () => {
    const journal = journalFor();
    const receipt: Receipt = {
      id: `rcp_${randomUUID()}`,
      actionId: "refund_001",
      planHash: HASH,
      approvalId: "appr_1",
      outcome: "confirmed",
      providerRef: { vendor: "stripe", kind: "refund", id: "re_1" },
      observedEffect: { amount: 4210 },
      protection: "native_guard_with_documented_limits",
      holdReason: null,
      limitations: [],
      recordedAt: "2026-10-21T12:00:03.000Z",
    };
    await journal.recordReceipt(receipt);
    const first = await journal.appendEvent("run_1", "attempt.prepared", { n: 1 });
    const second = await journal.appendEvent("run_1", "attempt.confirmed", { n: 2 });
    expect(second.seq).toBeGreaterThan(first.seq);
  });
});
