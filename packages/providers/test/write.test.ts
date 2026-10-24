import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type Action, Attempt } from "@rehearsal/contracts";
import { type SummaryAction, summaryCountKey } from "@rehearsal/core";
import { happyPathBundle } from "@rehearsal/testkit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  classifyResponse,
  slackWriter,
  stripeWriter,
  type WriteTarget,
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
