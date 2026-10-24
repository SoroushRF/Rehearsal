import type { Attempt } from "@rehearsal/contracts";
import type { ReplyAction } from "@rehearsal/core";
import { type WorldConfig, type WriteTarget, zendeskReplyWriter } from "@rehearsal/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ENABLED,
  getComments,
  resetScratchTenants,
  SEED,
  scratchWorld,
  uniqueTenant,
} from "../src/harness";

/**
 * T3.11 on Era: the public reply goes out through the typed ticket route as an explicit public
 * comment (approved body + marker), and an uncertain send is resolved by reading the ticket's
 * comments for the marker. Zendesk has no exactly-once append, so a found reply must stay the only one.
 */
describe.skipIf(!ENABLED)("Zendesk public reply writer on Era", () => {
  let world: WorldConfig;
  let target: WriteTarget;
  const ticketId = String(SEED.otherTicketId);
  const ctx = () => ({ world: "operational", tenant: world.tenant }) as const;
  const reply: ReplyAction = {
    id: "reply_001",
    kind: "zendesk.ticket.appendPublicReply",
    args: {
      ticketId,
      public: true,
      template: { id: "refund-issued", version: 1 },
      values: { customerName: "Ana", amountMinor: 4210 },
      body: "Hi Ana,\n\nWe've refunded 42.10 CAD for the duplicate charge on your account. Sorry for the trouble.",
    },
  };
  const attemptOf = (operationKey: string, body: string): Attempt => ({
    id: `att_${operationKey}`,
    actionId: reply.id,
    planHash: "a".repeat(64),
    operationKey,
    attemptNo: 1,
    state: "unknown_outcome",
    request: {
      method: "PUT",
      path: `/api/v2/tickets/${ticketId}.json`,
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
  const repliesWith = async (marker: string) =>
    (await getComments(world, SEED.otherTicketId)).filter((c) => c.body.includes(marker));

  beforeAll(async () => {
    world = await scratchWorld("zendesk", "operational", uniqueTenant("replyw"));
    target = { world: "operational", config: world, authorization: "Bearer rehearsal-conformance" };
  });
  afterAll(resetScratchTenants);

  it("sends the approved reply as a public comment and reads it back by its marker", async () => {
    const key = `op_${uniqueTenant("send")}`;
    const w = zendeskReplyWriter(target);
    const req = w.prepare(reply, key);
    expect(await w.dispatch(req, ctx())).toMatchObject({ kind: "confirmed", status: 200 });
    const read = await w.reconcile(attemptOf(key, req.body), reply, ctx());
    expect(read).toMatchObject({ kind: "applied", effect: { public: true } });
    const found = await repliesWith(`[rehearsal-op:${key}]`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      public: true,
      body: `${reply.args.body}\n\n[rehearsal-op:${key}]`,
    });
  });

  it("resolves a reply whose response was lost by reading the comments; it stays the only one", async () => {
    const key = `op_${uniqueTenant("lost")}`;
    const w = zendeskReplyWriter(target);
    const req = w.prepare(reply, key);
    await w.dispatch(req, ctx()); // lands; the test drops its response
    expect((await w.reconcile(attemptOf(key, req.body), reply, ctx())).kind).toBe("applied");
    expect(await repliesWith(`[rehearsal-op:${key}]`)).toHaveLength(1);
  });

  it("reads a reply that never went out as not applied", async () => {
    const key = `op_${uniqueTenant("never")}`;
    const w = zendeskReplyWriter(target);
    expect(await w.reconcile(attemptOf(key, w.prepare(reply, key).body), reply, ctx())).toEqual({
      kind: "not_applied",
    });
  });
});
