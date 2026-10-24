import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type Action, Attempt } from "@rehearsal/contracts";
import {
  type CreditAction,
  creditEffectMatches,
  type ReplyAction,
  type SummaryAction,
  summaryCountKey,
} from "@rehearsal/core";
import { happyPathBundle } from "@rehearsal/testkit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  classifyResponse,
  slackWriter,
  stripeCreditWriter,
  stripeWriter,
  type WriteTarget,
  zendeskReplyWriter,
  zendeskWriter,
} from "../src";

const actions = happyPathBundle().manifest.actions;
const byId = (id: string) => {
  const a = actions.find((x) => x.id === id);
  if (!a) throw new Error(`fixture has no ${id}`);
  return a;
};
const refund = byId("refund_001");
const patch = byId("patch_001");
const note = byId("note_001");
const CTX = { world: "operational", tenant: "t1" } as const;

interface Seen {
  method?: string;
  url?: string;
  headers: IncomingMessage["headers"];
  body: string;
}

let server: Server;
let seen: Seen[] = [];
let reply: { status: number; body: string; headers?: Record<string, string>; delayMs?: number } = {
  status: 200,
  body: "{}",
};
/** Replies served in order before falling back to `reply`. */
let queue: (typeof reply)[] = [];
let target: WriteTarget;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const r = queue.shift() ?? reply;
      setTimeout(() => {
        res.writeHead(r.status, { "content-type": "application/json", ...r.headers });
        res.end(r.body);
      }, r.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  target = {
    world: "operational",
    config: { baseUrl: `http://127.0.0.1:${port}`, tenant: "t1", tenantToken: "signed.jwt" },
    authorization: "Bearer sk_test_x",
    timeoutMs: 200,
  };
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  seen = [];
  queue = [];
  reply = { status: 200, body: "{}" };
});

describe("classifyResponse", () => {
  it.each([
    [200, "confirmed"],
    [201, "confirmed"],
    [400, "rejected"],
    [402, "rejected"],
    [409, "rejected"],
    [429, "rejected"],
    [500, "unknown"],
    [503, "unknown"],
  ])("%i → %s", (status, kind) => {
    expect(classifyResponse(status, {}, null).kind).toBe(kind);
  });

  it("treats 429 as retryable and reads Retry-After seconds", () => {
    expect(classifyResponse(429, {}, "2")).toMatchObject({ retryable: true, retryAfterMs: 2000 });
    expect(classifyResponse(409, {}, null)).toMatchObject({ retryable: false });
  });
});

describe("refund reconciliation correlation", () => {
  it.each([{ status: "failed" }, { amount: 1 }, { charge: "ch_other" }, { currency: "usd" }])(
    "does not confirm a matching marker with contradictory fields: %j",
    async (change) => {
      const writer = stripeWriter(target);
      const request = writer.prepare(refund, new Map(), "op_read");
      const attempt = Attempt.parse({
        id: "att",
        actionId: refund.id,
        planHash: "a".repeat(64),
        operationKey: "op_read",
        attemptNo: 1,
        state: "unknown_outcome",
        request: { ...request, bodySha256: "b".repeat(64) },
        providerStatus: null,
        error: null,
        preparedAt: "2026-10-22T00:00:00Z",
        dispatchedAt: "2026-10-22T00:00:00Z",
        settledAt: null,
      });
      reply.body = JSON.stringify({
        data: [
          {
            id: "re_read",
            status: "succeeded",
            amount: 4210,
            charge: "ch_fixture_001",
            currency: "cad",
            metadata: { rehearsal_op: "op_read" },
            ...change,
          },
        ],
        has_more: false,
      });
      expect(await writer.reconcile(attempt, refund, CTX)).toMatchObject({ kind: "indeterminate" });
    },
  );

  it("correlates a changed revision's read to the original dispatched bytes", async () => {
    const writer = stripeWriter(target);
    const request = writer.prepare(refund, new Map(), "op_old");
    const attempt = Attempt.parse({
      id: "att",
      actionId: refund.id,
      planHash: "a".repeat(64),
      operationKey: "op_old",
      attemptNo: 1,
      state: "unknown_outcome",
      request: { ...request, bodySha256: "b".repeat(64) },
      providerStatus: null,
      error: null,
      preparedAt: "2026-10-22T00:00:00Z",
      dispatchedAt: "2026-10-22T00:00:00Z",
      settledAt: null,
    });
    reply.body = JSON.stringify({
      data: [
        {
          id: "re_old",
          status: "succeeded",
          amount: 4210,
          charge: "ch_fixture_001",
          currency: "cad",
          metadata: { rehearsal_op: "op_old" },
        },
      ],
      has_more: false,
    });
    const revised = structuredClone(refund);
    if (revised.kind !== "stripe.refund.create") throw new Error("not a refund");
    revised.args.amount.amountMinor = 1;
    expect(await writer.reconcile(attempt, revised, CTX)).toMatchObject({
      kind: "applied",
      effect: { "refund.amount": 4210 },
    });
  });
});

describe("stripeWriter", () => {
  const w = () => stripeWriter(target);

  it("prepares the same bytes every time, keyed by the operation key", () => {
    const a = w().prepare(refund, new Map(), "op_1");
    const b = w().prepare(structuredClone(refund), new Map(), "op_1");
    expect(a).toEqual(b);
    expect(a).toMatchObject({ method: "POST", path: "/v1/refunds", encoding: "form" });
    expect(a.headers).toEqual({ "idempotency-key": "op_1" });
    expect(new URLSearchParams(a.body).get("metadata[rehearsal_op]")).toBe("op_1");
    expect(a.body.startsWith("charge=ch_fixture_001&amount=4210&reason=duplicate&")).toBe(true);
  });

  it("refuses actions it doesn't own", () => {
    expect(() => w().prepare(patch, new Map(), "op_1")).toThrow(/stripe can't/);
  });

  it("treats a 409 (key in use by a concurrent request) as unknown, not rejected", async () => {
    reply = { status: 409, body: JSON.stringify({ error: { type: "idempotency_error" } }) };
    const result = await w().dispatch(w().prepare(refund, new Map(), "op_1"), CTX);
    expect(result.kind).toBe("unknown");
  });

  it("sends the exact bytes with tenant, auth and idempotency headers", async () => {
    reply = {
      status: 200,
      body: JSON.stringify({ id: "re_1", amount: 4210, status: "succeeded" }),
    };
    const req = w().prepare(refund, new Map(), "op_1");
    const result = await w().dispatch(req, CTX);
    expect(result).toMatchObject({ kind: "confirmed", status: 200, body: { id: "re_1" } });
    const [s] = seen;
    expect(s?.body).toBe(req.body);
    expect(s?.headers["idempotency-key"]).toBe("op_1");
    expect(s?.headers["x-sim-tenant"]).toBe("signed.jwt");
    expect(s?.headers.authorization).toBe("Bearer sk_test_x");
    expect(s?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  it("reports a timeout as unknown, never rejected", async () => {
    reply = { status: 200, body: "{}", delayMs: 400 };
    const result = await w().dispatch(w().prepare(refund, new Map(), "op_1"), CTX);
    expect(result.kind).toBe("unknown");
  });

  it("refuses to write to a world or tenant it isn't bound to", async () => {
    const req = w().prepare(refund, new Map(), "op_1");
    await expect(w().dispatch(req, { world: "planning", tenant: "t1" })).rejects.toThrow(
      /bound to/,
    );
    await expect(w().dispatch(req, { world: "operational", tenant: "t2" })).rejects.toThrow(
      /bound to/,
    );
    expect(seen).toEqual([]);
  });
});

describe("zendeskWriter", () => {
  const w = () => zendeskWriter(target);

  it("reads the updated_stamp for a guarded patch", async () => {
    reply = {
      status: 200,
      body: JSON.stringify({ ticket: { updated_at: "2026-10-01T12:00:05Z" } }),
    };
    expect(await w().preconditions?.(patch, CTX)).toEqual({
      updated_stamp: "2026-10-01T12:00:05Z",
    });
    expect(seen[0]).toMatchObject({ method: "GET", url: "/api/v2/tickets/5531.json" });
    expect(await w().preconditions?.(note, CTX)).toEqual({});
  });

  it("a failed precondition read throws (the executor holds the step)", async () => {
    reply = { status: 404, body: "{}" };
    await expect(w().preconditions?.(patch, CTX)).rejects.toThrow(/404/);
  });

  it("prepares a guarded patch with safe_update and the stamp, in fixed key order", () => {
    const req = w().prepare(patch, new Map(), "op_p", { updated_stamp: "S1" });
    expect(req).toMatchObject({
      method: "PUT",
      path: "/api/v2/tickets/5531.json",
      encoding: "json",
    });
    expect(req.body).toBe('{"ticket":{"priority":"high","safe_update":true,"updated_stamp":"S1"}}');
    expect(() => w().prepare(patch, new Map(), "op_p")).toThrow(/updated_stamp/);
  });

  it("prepares a private note with explicit public:false and the operation marker", () => {
    const req = w().prepare(note, new Map([["refund_001:refund.id", "re_real"]]), "op_n");
    const parsed = JSON.parse(req.body) as {
      ticket: { comment: { body: string; public: boolean } };
    };
    expect(parsed.ticket.comment.public).toBe(false);
    expect(parsed.ticket.comment.body).toContain("re_real");
    expect(parsed.ticket.comment.body).toContain("[rehearsal-op:op_n]");
    expect(() => w().prepare(note, new Map(), "op_n")).toThrow(/unresolved binding/);
  });

  it("recovers the stamp a journaled patch was prepared with", () => {
    const req = w().prepare(patch, new Map(), "op_p", { updated_stamp: "S1" });
    const attempt = { ...req, bodySha256: "0".repeat(64) };
    expect(w().preconditionsOf?.(attempt)).toEqual({ updated_stamp: "S1" });
    const noteReq = w().prepare(note, new Map([["refund_001:refund.id", "re"]]), "op_n");
    expect(w().preconditionsOf?.({ ...noteReq, bodySha256: "0".repeat(64) })).toEqual({});
  });

  it("maps a 409 UpdateConflict to a non-retryable rejection", async () => {
    reply = { status: 409, body: JSON.stringify({ error: "UpdateConflict" }) };
    const req = w().prepare(patch, new Map(), "op_p", { updated_stamp: "S1" });
    expect(await w().dispatch(req, CTX)).toMatchObject({
      kind: "rejected",
      status: 409,
      retryable: false,
    });
  });

  it("refuses actions it doesn't own", () => {
    expect(() => w().prepare(refund as Action, new Map(), "op")).toThrow(/zendesk can't/);
  });
});

describe("zendeskReplyWriter (T3.11)", () => {
  const body =
    "Hi Ana,\n\nWe've refunded 42.10 CAD for the duplicate charge on your account. Sorry for the trouble.";
  const reply: ReplyAction = {
    id: "reply_001",
    kind: "zendesk.ticket.appendPublicReply",
    args: {
      ticketId: "5531",
      public: true,
      template: { id: "refund-issued", version: 1 },
      values: { customerName: "Ana", amountMinor: 4210 },
      body,
    },
  };
  const KEY = "op_reply_key";
  const comment = `${body}\n\n[rehearsal-op:op_reply_key]`;
  const attemptFor = (requestBody: string) =>
    Attempt.parse({
      id: "att_r",
      actionId: "reply_001",
      planHash: "a".repeat(64),
      operationKey: KEY,
      attemptNo: 1,
      state: "unknown_outcome",
      request: {
        method: "PUT",
        path: "/api/v2/tickets/5531.json",
        encoding: "json",
        body: requestBody,
        bodySha256: "b".repeat(64),
      },
      providerStatus: null,
      error: null,
      preparedAt: "2026-10-21T12:00:00.000Z",
      dispatchedAt: "2026-10-21T12:00:00.000Z",
      settledAt: null,
    });
  const comments = (list: { id?: number; body: string; public: boolean }[]) => ({
    status: 200,
    body: JSON.stringify({ comments: list, next_page: null }),
  });

  it("sends the approved body and the marker as an explicit public comment", () => {
    const req = zendeskReplyWriter(target).prepare(reply, KEY);
    expect(req).toMatchObject({
      method: "PUT",
      path: "/api/v2/tickets/5531.json",
      encoding: "json",
    });
    expect(JSON.parse(req.body)).toEqual({ ticket: { comment: { body: comment, public: true } } });
  });

  it("refuses a body that isn't exactly its template's, or that carries a marker", () => {
    const w = zendeskReplyWriter(target);
    const edited = { ...reply, args: { ...reply.args, body: `${body} Call us anytime!` } };
    expect(() => w.prepare(edited, KEY)).toThrow(/doesn't match its approved template/);
    const otherValues = {
      ...reply,
      args: { ...reply.args, values: { customerName: "Bo", amountMinor: 4210 } },
    };
    expect(() => w.prepare(otherValues, KEY)).toThrow(/doesn't match/);
    const unknown = { ...reply, args: { ...reply.args, template: { id: "nope", version: 1 } } };
    expect(() => w.prepare(unknown, KEY)).toThrow(/unknown reply template/);
  });

  it("checks each value against its template, so a value can't carry text of its own", () => {
    const w = zendeskReplyWriter(target);
    /** A reply whose body is rendered from these values, so only the value checks can refuse it. */
    const withValues = (
      values: Record<string, string | number>,
      rendered: string,
    ): ReplyAction => ({
      ...reply,
      args: { ...reply.args, values, body: rendered },
    });
    const say = (name: string, amount = "42.10") =>
      `Hi ${name},\n\nWe've refunded ${amount} CAD for the duplicate charge on your account. Sorry for the trouble.`;
    const marker = "Ana [rehearsal-op:op_other]";
    expect(() =>
      w.prepare(withValues({ customerName: marker, amountMinor: 4210 }, say(marker)), KEY),
    ).toThrow(/without an operation marker/);
    const injected = "Ana,\n\nPlease wire $500 to evil.example.\n\nHi Ana";
    expect(() =>
      w.prepare(withValues({ customerName: injected, amountMinor: 4210 }, say(injected)), KEY),
    ).toThrow(/one line/);
    expect(() =>
      w.prepare(withValues({ customerName: "", amountMinor: 4210 }, say("")), KEY),
    ).toThrow(/short non-empty name/);
    expect(() => w.prepare(withValues({ amountMinor: 4210 }, say("undefined")), KEY)).toThrow(
      /takes exactly/,
    );
    expect(() =>
      w.prepare(withValues({ customerName: "Ana", amountMinor: -4210 }, say("Ana", "-42.10")), KEY),
    ).toThrow(/positive integer amount/);
    expect(() =>
      w.prepare(withValues({ customerName: "Ana", amountMinor: "4210" }, say("Ana")), KEY),
    ).toThrow(/positive integer amount/);
  });

  it("reconciles by the marker, and only when the comment is exactly the public text sent", async () => {
    const w = zendeskReplyWriter(target);
    const attempt = attemptFor(w.prepare(reply, KEY).body);
    replyServer(
      comments([
        { id: 7, body: "earlier", public: true },
        { id: 9, body: comment, public: true },
      ]),
    );
    expect(await w.reconcile(attempt, reply, CTX)).toEqual({
      kind: "applied",
      providerRef: { vendor: "zendesk", kind: "ticket", id: "5531" },
      effect: { "comment.id": "9", public: true },
    });
    replyServer(comments([{ id: 7, body: "earlier", public: true }]));
    expect(await w.reconcile(attempt, reply, CTX)).toEqual({ kind: "not_applied" });
    replyServer(comments([{ id: 9, body: comment, public: false }]));
    expect((await w.reconcile(attempt, reply, CTX)).kind).toBe("indeterminate");
    replyServer(comments([{ id: 9, body: `${comment} (edited)`, public: true }]));
    expect((await w.reconcile(attempt, reply, CTX)).kind).toBe("indeterminate");
  });

  it("has no idempotent re-send and writes only to its bound world", async () => {
    const w = zendeskReplyWriter(target);
    expect("idempotentResend" in w).toBe(false);
    await expect(
      w.dispatch(w.prepare(reply, KEY), { world: "planning", tenant: "t1" }),
    ).rejects.toThrow(/bound to operational/);
  });
});

function replyServer(r: { status: number; body: string }) {
  reply = r;
}

describe("stripeCreditWriter (T3.12)", () => {
  const credit: CreditAction = {
    id: "credit_001",
    kind: "stripe.customer.balanceCredit",
    args: { customerId: "cus_1", chargeId: "ch_1", amount: { amountMinor: 1500, currency: "cad" } },
  };
  const KEY = "op_credit_key";
  const tx = (over: Record<string, unknown> = {}) => ({
    id: "cbtxn_1",
    amount: -1500,
    currency: "cad",
    customer: "cus_1",
    type: "adjustment",
    metadata: { rehearsal_op: KEY },
    ...over,
  });
  const page = (data: unknown[], hasMore = false) => ({
    status: 200,
    body: JSON.stringify({ data, has_more: hasMore }),
  });
  const attemptFor = (body: string) =>
    Attempt.parse({
      id: "att_c",
      actionId: "credit_001",
      planHash: "a".repeat(64),
      operationKey: KEY,
      attemptNo: 1,
      state: "unknown_outcome",
      request: {
        method: "POST",
        path: "/v1/customers/cus_1/balance_transactions",
        encoding: "form",
        body,
        bodySha256: "b".repeat(64),
      },
      providerStatus: null,
      error: null,
      preparedAt: "2026-10-21T12:00:00.000Z",
      dispatchedAt: "2026-10-21T12:00:00.000Z",
      settledAt: null,
    });
  const effectOf = (t: ReturnType<typeof tx>) => ({
    "credit.id": t.id,
    "credit.amount": t.amount,
    "credit.type": t.type,
    customer: t.customer,
    currency: t.currency,
  });

  it("prepares a negative balance transaction in a fixed order, keyed by the operation", () => {
    const req = stripeCreditWriter(target).prepare(credit, KEY);
    expect(req).toEqual({
      method: "POST",
      path: "/v1/customers/cus_1/balance_transactions",
      encoding: "form",
      body: "amount=-1500&currency=cad&metadata%5Brehearsal_op%5D=op_credit_key",
      headers: { "idempotency-key": KEY },
    });
  });

  it("refuses a zero, negative or fractional credit", () => {
    const w = stripeCreditWriter(target);
    for (const amountMinor of [0, -1500, 15.5]) {
      const bad = { ...credit, args: { ...credit.args, amount: { amountMinor, currency: "cad" } } };
      expect(() => w.prepare(bad, KEY)).toThrow(/positive integer/);
    }
  });

  it("checks the customer's currency; a customer with none yet takes the credit's", async () => {
    const w = stripeCreditWriter(target);
    for (const currency of [null, undefined, "cad"]) {
      reply = { status: 200, body: JSON.stringify(currency === undefined ? {} : { currency }) };
      await expect(w.preconditions(credit, CTX)).resolves.toEqual({});
    }
    reply = { status: 200, body: JSON.stringify({ currency: "usd" }) };
    await expect(w.preconditions(credit, CTX)).rejects.toThrow(/is in usd, the credit is in cad/);
  });

  it("re-sends only as an identical idempotent replay, and treats a key in use as unknown", async () => {
    const w = stripeCreditWriter(target);
    expect(w.idempotentResend(credit)).toBe(true);
    reply = { status: 409, body: JSON.stringify({ error: { type: "idempotency_error" } }) };
    expect(await w.dispatch(w.prepare(credit, KEY), CTX)).toMatchObject({ kind: "unknown" });
    reply = { status: 400, body: JSON.stringify({ error: { type: "idempotency_error" } }) };
    expect(await w.dispatch(w.prepare(credit, KEY), CTX)).toMatchObject({
      kind: "rejected",
      retryable: false,
    });
  });

  it("confirms only the exact approved credit", () => {
    const ok = tx();
    expect(creditEffectMatches(credit, effectOf(ok))).toBe(true);
    for (const over of [
      { id: "" },
      { type: "invoice_balance" },
      { customer: "cus_other" },
      { amount: -1600 },
      { amount: 1500 },
      { currency: "usd" },
    ]) {
      expect(creditEffectMatches(credit, effectOf(tx(over)))).toBe(false);
    }
  });

  it("reads a lost credit back by its key across pages, and can't tell when the read contradicts it", async () => {
    const w = stripeCreditWriter(target);
    const attempt = attemptFor(w.prepare(credit, KEY).body);
    queue = [
      page([tx({ id: "cbtxn_0", metadata: { rehearsal_op: "op_other" } })], true),
      page([tx()]),
    ];
    expect(await w.reconcile(attempt, credit, CTX)).toEqual({
      kind: "applied",
      providerRef: { vendor: "stripe", kind: "customer_balance_transaction", id: "cbtxn_1" },
      effect: effectOf(tx()),
    });
    expect(seen[1]?.url).toContain("starting_after=cbtxn_0");

    reply = page([tx({ amount: -1600 })]);
    expect(await w.reconcile(attempt, credit, CTX)).toMatchObject({
      kind: "indeterminate",
      detail: "credit read contradicts the journaled operation",
      contradicts: true,
    });
    reply = page([]);
    expect(await w.reconcile(attempt, credit, CTX)).toEqual({ kind: "not_applied" });
  });

  it("judges a found credit against the bytes that were sent, not a revision's", async () => {
    const w = stripeCreditWriter(target);
    const sent = attemptFor(w.prepare(credit, KEY).body); // rev 1 sent 1500
    const revised = {
      ...credit,
      args: { ...credit.args, amount: { amountMinor: 1600, currency: "cad" } },
    };
    reply = page([tx()]);
    expect(await w.reconcile(sent, revised, CTX)).toMatchObject({
      kind: "applied",
      effect: { "credit.amount": -1500 },
    });
  });

  it("can't tell on a repeated or duplicated page", async () => {
    const w = stripeCreditWriter(target);
    const attempt = attemptFor(w.prepare(credit, KEY).body);
    const other = tx({ id: "cbtxn_x", metadata: {} });
    queue = [page([other], true), page([other], true)];
    expect(await w.reconcile(attempt, credit, CTX)).toMatchObject({
      kind: "indeterminate",
      detail: "repeated balance transaction cursor",
    });
    reply = page([other, other], true);
    expect(await w.reconcile(attempt, credit, CTX)).toMatchObject({ kind: "indeterminate" });
  });
});

describe("slackWriter (T3.10)", () => {
  const summary: SummaryAction = {
    id: "summary_001",
    kind: "slack.message.postSummary",
    args: {
      channelId: "chan-ops",
      template: { id: "run-summary", version: 1 },
      bindings: {
        incidentId: "INC-BILL-0927",
        refunded: {
          $count: "outcomes",
          stepIds: ["refund_001", "refund_002"],
          outcomes: ["confirmed"],
        },
        held: { $count: "outcomes", stepIds: ["refund_001", "refund_002"], outcomes: ["held"] },
      },
    },
  };
  const counts = new Map([
    [summaryCountKey("refunded"), 1],
    [summaryCountKey("held"), 1],
  ]);
  const KEY = "op_summary_key";
  const attemptFor = (body: string) =>
    Attempt.parse({
      id: "att_s",
      actionId: "summary_001",
      planHash: "a".repeat(64),
      operationKey: KEY,
      attemptNo: 1,
      state: "unknown_outcome",
      request: {
        method: "POST",
        path: "/api/chat.postMessage",
        encoding: "json",
        body,
        bodySha256: "b".repeat(64),
      },
      providerStatus: null,
      error: null,
      preparedAt: "2026-10-21T12:00:00.000Z",
      dispatchedAt: "2026-10-21T12:00:00.000Z",
      settledAt: null,
    });

  it("renders the approved template with literals, outcome counts and the marker", () => {
    const req = slackWriter(target).prepare(summary, counts, KEY);
    expect(req).toMatchObject({ method: "POST", path: "/api/chat.postMessage", encoding: "json" });
    expect(JSON.parse(req.body)).toEqual({
      channel: "chan-ops",
      text: "Billing remediation INC-BILL-0927: 1 refund(s) issued, 1 step(s) held for review.\n\n[rehearsal-op:op_summary_key]",
    });
  });

  it("refuses to render without every outcome count, or with an unknown template", () => {
    const w = slackWriter(target);
    expect(() => w.prepare(summary, new Map(), KEY)).toThrow(/unresolved summary count/);
    expect(() =>
      w.prepare(
        { ...summary, args: { ...summary.args, template: { id: "nope", version: 1 } } },
        counts,
        KEY,
      ),
    ).toThrow(/unknown summary template/);
  });

  it("maps Slack's 200 ok:false to a refusal, ratelimited to a retryable one", async () => {
    const w = slackWriter(target);
    const req = w.prepare(summary, counts, KEY);
    reply = { status: 200, body: JSON.stringify({ ok: false, error: "channel_not_found" }) };
    expect(await w.dispatch(req, CTX)).toMatchObject({ kind: "rejected", retryable: false });
    reply = { status: 200, body: JSON.stringify({ ok: false, error: "ratelimited" }) };
    expect(await w.dispatch(req, CTX)).toMatchObject({
      kind: "rejected",
      status: 429,
      retryable: true,
    });
    reply = { status: 200, body: JSON.stringify({ ok: true, ts: "1.2", channel: "chan-ops" }) };
    expect(await w.dispatch(req, CTX)).toMatchObject({ kind: "confirmed" });
    reply = { status: 200, body: JSON.stringify({ ok: true }) };
    expect(await w.dispatch(req, CTX)).toMatchObject({ kind: "unknown" });
    reply = { status: 503, body: "{}" };
    expect(await w.dispatch(req, CTX)).toMatchObject({ kind: "unknown" });
  });

  it("finds a post by its marker on a later history page", async () => {
    const w = slackWriter(target);
    const req = w.prepare(summary, counts, KEY);
    const page = (messages: { ts: string; text: string; bot_id?: string }[], next?: string) => ({
      status: 200,
      body: JSON.stringify({
        ok: true,
        messages,
        has_more: next !== undefined,
        response_metadata: { next_cursor: next ?? "" },
      }),
    });
    queue = [
      page([{ ts: "3", text: "someone else" }], "c1"),
      page([{ ts: "2", text: JSON.parse(req.body).text, bot_id: "B1" }]),
    ];
    expect(await w.reconcile(attemptFor(req.body), summary, CTX)).toEqual({
      kind: "applied",
      providerRef: { vendor: "slack", kind: "message", id: "2" },
      effect: { "message.ts": "2", channel: "chan-ops" },
    });
    expect(seen[1]?.url).toContain("cursor=c1");
  });

  it("treats errors that may have posted as unknown, never as a refusal", async () => {
    const w = slackWriter(target);
    const req = w.prepare(summary, counts, KEY);
    for (const error of [
      "internal_error",
      "fatal_error",
      "service_unavailable",
      "brand_new_code",
    ]) {
      reply = { status: 200, body: JSON.stringify({ ok: false, error }) };
      expect(await w.dispatch(req, CTX)).toMatchObject({ kind: "unknown" });
    }
  });

  it("doesn't take a person quoting the summary for the post", async () => {
    const w = slackWriter(target);
    const req = w.prepare(summary, counts, KEY);
    reply = {
      status: 200,
      body: JSON.stringify({
        ok: true,
        messages: [{ ts: "5", text: `> ${JSON.parse(req.body).text}` }],
        has_more: false,
      }),
    };
    expect((await w.reconcile(attemptFor(req.body), summary, CTX)).kind).toBe("indeterminate");
  });

  it("keeps paging past a quote of the summary to find the real post (review)", async () => {
    const w = slackWriter(target);
    const req = w.prepare(summary, counts, KEY);
    const text = JSON.parse(req.body).text as string;
    const page = (messages: object[], next?: string) => ({
      status: 200,
      body: JSON.stringify({
        ok: true,
        messages,
        has_more: next !== undefined,
        response_metadata: { next_cursor: next ?? "" },
      }),
    });
    queue = [page([{ ts: "9", text: `> ${text}` }], "c1"), page([{ ts: "2", text, bot_id: "B1" }])];
    expect(await w.reconcile(attemptFor(req.body), summary, CTX)).toMatchObject({
      kind: "applied",
      providerRef: { id: "2" },
    });
  });

  it("takes only a bot message with exactly the journaled text as the post (review)", async () => {
    const w = slackWriter(target);
    const req = w.prepare(summary, counts, KEY);
    const text = JSON.parse(req.body).text as string;
    const altered = text.replace("1 refund(s)", "999 refund(s)");
    reply = {
      status: 200,
      body: JSON.stringify({
        ok: true,
        messages: [{ ts: "7", text: altered, bot_id: "B2" }],
        has_more: false,
      }),
    };
    expect(await w.reconcile(attemptFor(req.body), summary, CTX)).toMatchObject({
      kind: "indeterminate",
      detail: "only messages that aren't this exact post carry its marker",
    });
    // Slack returns &, < and > escaped; the journaled text is compared unescaped.
    const amp = {
      ...summary,
      args: { ...summary.args, bindings: { ...summary.args.bindings, incidentId: "INC <a&b>" } },
    };
    const ampReq = w.prepare(amp, counts, KEY);
    const escaped = (JSON.parse(ampReq.body).text as string)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
    reply = {
      status: 200,
      body: JSON.stringify({
        ok: true,
        messages: [{ ts: "8", text: escaped, bot_id: "B1" }],
        has_more: false,
      }),
    };
    expect((await w.reconcile(attemptFor(ampReq.body), amp, CTX)).kind).toBe("applied");
  });

  it("can't tell when Slack says there is more history but gives no cursor", async () => {
    const w = slackWriter(target);
    reply = {
      status: 200,
      body: JSON.stringify({
        ok: true,
        messages: [],
        has_more: true,
        response_metadata: { next_cursor: "" },
      }),
    };
    expect(
      await w.reconcile(attemptFor(w.prepare(summary, counts, KEY).body), summary, CTX),
    ).toMatchObject({
      kind: "indeterminate",
      detail: "more Slack history but no cursor",
    });
  });

  it("renders only the template's own bindings: literals short and single-line, counts as counts", () => {
    const w = slackWriter(target);
    const withBindings = (bindings: SummaryAction["args"]["bindings"]): SummaryAction => ({
      ...summary,
      args: { ...summary.args, bindings },
    });
    const bound = summary.args.bindings;
    const incidentId = bound.incidentId as string;
    const refunded = bound.refunded as NonNullable<typeof bound.refunded>;
    const held = bound.held as NonNullable<typeof bound.held>;
    expect(() => w.prepare(withBindings({ incidentId, refunded }), counts, KEY)).toThrow(
      /takes exactly/,
    );
    expect(() =>
      w.prepare(withBindings({ incidentId, refunded, held, extra: "x" }), counts, KEY),
    ).toThrow(/takes exactly/);
    expect(() => w.prepare(withBindings({ incidentId, refunded: 7, held }), counts, KEY)).toThrow(
      /must be a count of approved steps' outcomes/,
    );
    expect(() =>
      w.prepare(
        withBindings({ incidentId: "INC [rehearsal-op:op_other]", refunded, held }),
        counts,
        KEY,
      ),
    ).toThrow(/without an operation marker/);
    expect(() =>
      w.prepare(withBindings({ incidentId: "INC\nline two", refunded, held }), counts, KEY),
    ).toThrow(/one line/);
    expect(() =>
      w.prepare(withBindings({ incidentId: "x".repeat(201), refunded, held }), counts, KEY),
    ).toThrow(/short non-empty/);
    expect(() =>
      w.prepare(
        summary,
        new Map([
          [summaryCountKey("refunded"), -1],
          [summaryCountKey("held"), 0],
        ]),
        KEY,
      ),
    ).toThrow(/non-negative integer/);
  });

  it("reads not_applied only after the last page; an unreadable page can't tell", async () => {
    const w = slackWriter(target);
    const attempt = attemptFor(w.prepare(summary, counts, KEY).body);
    reply = { status: 200, body: JSON.stringify({ ok: true, messages: [], has_more: false }) };
    expect(await w.reconcile(attempt, summary, CTX)).toEqual({ kind: "not_applied" });
    reply = { status: 200, body: JSON.stringify({ ok: false, error: "channel_not_found" }) };
    expect((await w.reconcile(attempt, summary, CTX)).kind).toBe("indeterminate");
    queue = [
      {
        status: 200,
        body: JSON.stringify({
          ok: true,
          messages: [],
          has_more: true,
          response_metadata: { next_cursor: "x" },
        }),
      },
      {
        status: 200,
        body: JSON.stringify({
          ok: true,
          messages: [],
          has_more: true,
          response_metadata: { next_cursor: "x" },
        }),
      },
    ];
    expect(await w.reconcile(attempt, summary, CTX)).toMatchObject({
      kind: "indeterminate",
      detail: "repeated Slack cursor",
    });
  });

  it("writes only to the world it is bound to", async () => {
    const w = slackWriter(target);
    await expect(
      w.dispatch(w.prepare(summary, counts, KEY), { world: "planning", tenant: "t1" }),
    ).rejects.toThrow(/bound to operational/);
  });
});
