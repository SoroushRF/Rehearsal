import { Attempt } from "@rehearsal/contracts";
import { happyPathBundle } from "@rehearsal/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stripeWriter, zendeskWriter } from "../src";

const target = {
  world: "operational",
  config: { baseUrl: "http://world.test", tenant: "test" },
  authorization: "Bearer test",
} as const;
const ctx = { world: "operational", tenant: "test" } as const;
const otherRefund = {
  id: "re_other",
  amount: 1,
  currency: "cad",
  charge: "ch_fixture_001",
  status: "succeeded",
};
afterEach(() => vi.restoreAllMocks());

function serve(...pages: unknown[]) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    if (!pages.length) throw new Error("unexpected page");
    return Response.json(pages.shift());
  });
}

function setup(kind: "refund_001" | "note_001") {
  const action = happyPathBundle().manifest.actions.find((a) => a.id === kind);
  if (!action) throw new Error("missing action");
  const writer = kind === "refund_001" ? stripeWriter(target) : zendeskWriter(target);
  const request = writer.prepare(
    action,
    new Map([["refund_001:refund.id", "re_original"]]),
    "op_pending",
  );
  const attempt = Attempt.parse({
    id: "a",
    actionId: action.id,
    planHash: "a".repeat(64),
    operationKey: "op_pending",
    attemptNo: 1,
    state: "unknown_outcome",
    request: { ...request, bodySha256: "b".repeat(64) },
    providerStatus: null,
    error: null,
    preparedAt: "2026-10-22T00:00:00Z",
    dispatchedAt: "2026-10-22T00:00:00Z",
    settledAt: null,
  });
  return { reconcile: () => writer.reconcile(attempt, action, ctx) };
}

describe("reconciliation pagination is not proof of absence until complete", () => {
  it.each([
    [{ data: [], has_more: true }],
    [{ data: [] }],
    [{ data: [{ id: "re_bad" }], has_more: false }],
    [
      { data: [otherRefund], has_more: true },
      { data: [otherRefund], has_more: false },
    ],
  ])("holds incomplete or invalid refund pages: %j", async (...pages) => {
    serve(...pages);
    expect(await setup("refund_001").reconcile()).toMatchObject({ kind: "indeterminate" });
  });

  it.each([
    [{ comments: [] }],
    [{ comments: [], next_page: "http://world.test/page2" }],
    [{ comments: [{ body: "other", public: false }], next_page: "http://foreign.test/page2" }],
    [
      {
        comments: [{ body: "other", public: false }],
        next_page: "http://world.test/api/v2/tickets/5531/comments.json",
      },
    ],
  ])("holds unknown or untrusted comment pagination: %j", async (...pages) => {
    serve(...pages);
    expect(await setup("note_001").reconcile()).toMatchObject({ kind: "indeterminate" });
  });

  it("accepts an explicitly terminated empty list as a negative read", async () => {
    serve({ data: [], has_more: false });
    expect(await setup("refund_001").reconcile()).toMatchObject({ kind: "not_applied" });
    serve({ comments: [], next_page: null });
    expect(await setup("note_001").reconcile()).toMatchObject({ kind: "not_applied" });
  });
});
