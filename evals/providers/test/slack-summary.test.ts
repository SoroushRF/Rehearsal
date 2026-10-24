import type { Attempt } from "@rehearsal/contracts";
import { type SummaryAction, summaryCountKey } from "@rehearsal/core";
import { slackWriter, type WorldConfig, type WriteTarget } from "@rehearsal/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getJson,
  resetScratchTenants,
  SLACK_ENABLED,
  scratchWorld,
  uniqueTenant,
  vendorFetch,
} from "../src/harness";

const CHANNEL = "chan-general";

interface History {
  ok: boolean;
  messages: { ts: string; text?: string }[];
}

/**
 * T3.10 on Era: the summary post goes through `chat.postMessage`, and an uncertain post is resolved
 * by reading `conversations.history` for its operation marker. Slack has no dedupe, so a found post
 * must stay the only one. Needs `pnpm infra:up:full` and ERA_SLACK=1.
 */
describe.skipIf(!SLACK_ENABLED)("Slack summary post on Era", () => {
  let world: WorldConfig;
  let target: WriteTarget;
  const ctx = () => ({ world: "operational", tenant: world.tenant }) as const;
  const summary: SummaryAction = {
    id: "summary_001",
    kind: "slack.message.postSummary",
    args: {
      channelId: CHANNEL,
      template: { id: "run-summary", version: 1 },
      bindings: {
        incidentId: "INC-BILL-0927",
        refunded: { $count: "outcomes", stepIds: ["refund_001"], outcomes: ["confirmed"] },
        held: { $count: "outcomes", stepIds: ["refund_001"], outcomes: ["held"] },
      },
    },
  };
  const counts = new Map([
    [summaryCountKey("refunded"), 1],
    [summaryCountKey("held"), 0],
  ]);
  const attemptOf = (operationKey: string, body: string): Attempt => ({
    id: `att_${operationKey}`,
    actionId: summary.id,
    planHash: "a".repeat(64),
    operationKey,
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
    preparedAt: new Date().toISOString(),
    dispatchedAt: new Date().toISOString(),
    settledAt: null,
  });
  const postsWith = async (marker: string) =>
    (
      await getJson<History>(
        "slack",
        world,
        `/api/conversations.history?channel=${CHANNEL}&limit=200`,
      )
    ).messages.filter((m) => m.text?.includes(marker));

  beforeAll(async () => {
    world = await scratchWorld("slack", "operational", uniqueTenant("slack"));
    target = {
      world: "operational",
      config: world,
      authorization: "Bearer xoxb-rehearsal-conformance",
    };
  });
  afterAll(resetScratchTenants);

  it("posts the rendered summary and reads it back by its marker", async () => {
    const key = `op_${uniqueTenant("post")}`;
    const w = slackWriter(target);
    const req = w.prepare(summary, counts, key);
    const sent = await w.dispatch(req, ctx());
    expect(sent).toMatchObject({ kind: "confirmed", body: { ok: true, channel: CHANNEL } });
    const ts = (sent as { body: { ts: string } }).body.ts;
    expect(await w.reconcile(attemptOf(key, req.body), summary, ctx())).toEqual({
      kind: "applied",
      providerRef: { vendor: "slack", kind: "message", id: ts },
      effect: { "message.ts": ts, channel: CHANNEL },
    });
    const posts = await postsWith(`[rehearsal-op:${key}]`);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.text).toContain(
      "Billing remediation INC-BILL-0927: 1 refund(s) issued, 0 step(s) held",
    );
  });

  it("resolves a post whose response was lost by reading the channel, and it stays the only one", async () => {
    const key = `op_${uniqueTenant("lost")}`;
    const w = slackWriter(target);
    const req = w.prepare(summary, counts, key);
    await w.dispatch(req, ctx()); // lands; the test drops its response
    const read = await w.reconcile(attemptOf(key, req.body), summary, ctx());
    expect(read.kind).toBe("applied");
    expect(await postsWith(`[rehearsal-op:${key}]`)).toHaveLength(1);
  });

  it("reads a post that never went out as not applied", async () => {
    const key = `op_${uniqueTenant("never")}`;
    const w = slackWriter(target);
    const req = w.prepare(summary, counts, key);
    expect(await w.reconcile(attemptOf(key, req.body), summary, ctx())).toEqual({
      kind: "not_applied",
    });
  });

  it("documents: Slack doesn't deduplicate on client_msg_id, so a blind re-send would double-post", async () => {
    const marker = `[dedupe ${uniqueTenant("cmid")}]`;
    const post = () =>
      vendorFetch("slack", world, "/api/chat.postMessage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: CHANNEL, text: marker, client_msg_id: "same-id-twice" }),
      });
    expect((await post()).ok).toBe(true);
    expect((await post()).ok).toBe(true);
    expect(await postsWith(marker)).toHaveLength(2);
  });

  it("maps a refused post (unknown channel) to a definite refusal, and nothing is posted", async () => {
    const key = `op_${uniqueTenant("refused")}`;
    const w = slackWriter(target);
    const bad = { ...summary, args: { ...summary.args, channelId: "chan-does-not-exist" } };
    expect(await w.dispatch(w.prepare(bad, counts, key), ctx())).toMatchObject({
      kind: "rejected",
      retryable: false,
      body: { ok: false, error: "channel_not_found" },
    });
    expect(await postsWith(`[rehearsal-op:${key}]`)).toHaveLength(0);
  });
});
