import type { WorldConfig } from "@rehearsal/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ENABLED,
  getComments,
  resetScratchTenants,
  SEED,
  scratchWorld,
  uniqueTenant,
  zendeskPutTicket,
} from "../src/harness";

const THIRD_TICKET = 4000002;

// T1.18: the semantics `zendesk.ticket.appendPublicReply` relies on. The customer reads the text,
// so it must arrive exactly as approved; the marker must be findable afterwards; and nothing
// deduplicates a repeated send, so an unknown outcome is resolved by reading, never by re-sending.
describe.skipIf(!ENABLED)("Zendesk public reply", () => {
  let world: WorldConfig;
  const marker = `[rehearsal-op:${uniqueTenant("reply")}]`;
  const approved = "Hi Ana,\n\nWe've refunded 42.10 CAD — the duplicate charge.  Sorry!";
  const sent = `${approved}\n\n${marker}`;

  beforeAll(async () => {
    world = await scratchWorld("zendesk", "planning", uniqueTenant("reply"));
  });

  afterAll(resetScratchTenants);

  it("appends a public comment that reads back byte for byte", async () => {
    const before = await getComments(world, SEED.ticketId);
    const res = await zendeskPutTicket(world, SEED.ticketId, {
      comment: { body: sent, public: true },
    });
    expect(res.status).toBe(200);

    const after = await getComments(world, SEED.ticketId);
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)).toMatchObject({ body: sent, public: true });
  });

  it("finds the reply by its marker, and only that one", async () => {
    const found = (await getComments(world, SEED.ticketId)).filter((c) => c.body.includes(marker));
    expect(found).toHaveLength(1);
    expect(found[0]?.body.slice(0, approved.length)).toBe(approved);
  });

  it("appends a second copy when the same reply is sent again", async () => {
    expect(
      (await zendeskPutTicket(world, SEED.ticketId, { comment: { body: sent, public: true } }))
        .status,
    ).toBe(200);
    const found = (await getComments(world, SEED.ticketId)).filter((c) => c.body.includes(marker));
    expect(found).toHaveLength(2);
  });

  // Fidelity gaps: Zendesk keeps custom audit metadata and renders html_body. Era drops the
  // metadata and appends an empty comment for html_body alone, so the marker goes in `body`.
  it("drops custom audit metadata and ignores html_body", async () => {
    const res = await zendeskPutTicket(world, SEED.otherTicketId, {
      comment: { body: "with metadata", public: true },
      metadata: { rehearsal_op: marker },
    });
    expect(res.status).toBe(200);
    const withMeta = (await getComments(world, SEED.otherTicketId)).at(-1) as unknown as {
      metadata: { custom: Record<string, unknown> };
    };
    expect(withMeta.metadata.custom).toEqual({});

    const html = await zendeskPutTicket(world, THIRD_TICKET, {
      comment: { html_body: "<p>Hi Ana</p>", public: true },
    });
    expect(html.status).toBe(200);
    expect((await getComments(world, THIRD_TICKET)).at(-1)).toMatchObject({
      body: "",
      public: true,
    });
  });
});
