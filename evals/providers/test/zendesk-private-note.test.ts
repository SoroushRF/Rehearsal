import type { WorldConfig } from "@rehearsal/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ENABLED,
  getComments,
  getTicket,
  resetScratchTenants,
  SEED,
  scratchWorld,
  uniqueTenant,
  type ZendeskComment,
  zendeskPutTicket,
} from "../src/harness";

const THIRD_TICKET = 4000002;

/** The comment fields that survive an update to the ticket unchanged. */
const stable = ({ id, body, public: isPublic, author_id }: ZendeskComment) => ({
  id,
  body,
  public: isPublic,
  author_id,
});

// Gate 4 (cont.): the private note is an append through the typed REST route with explicit
// public:false. REST defaults a comment to public, so visibility must always be sent.
describe.skipIf(!ENABLED)("Zendesk private note", () => {
  let world: WorldConfig;

  beforeAll(async () => {
    world = await scratchWorld("zendesk", "planning", uniqueTenant("note"));
  });

  afterAll(resetScratchTenants);

  it("appends an explicit public:false comment that reads back as private", async () => {
    const before = await getComments(world, SEED.ticketId);
    const marker = `[rehearsal-op ${uniqueTenant("note")}] Refund re_x issued for INV-812.`;

    const res = await zendeskPutTicket(world, SEED.ticketId, {
      comment: { body: marker, public: false },
    });
    expect(res.status).toBe(200);

    const after = await getComments(world, SEED.ticketId);
    expect(after).toHaveLength(before.length + 1);
    // Existing comments keep identity, text and visibility (created_at moves; see below).
    expect(after.slice(0, before.length).map(stable)).toEqual(before.map(stable));
    const note = after.at(-1);
    expect(note).toMatchObject({ body: marker, public: false });
  });

  it("guards a note with safe_update: stale stamp → 409 and nothing appended", async () => {
    const stampBefore = (await getTicket(world, SEED.ticketId)).updated_at;
    // Move the stamp on (>1 s so the earlier write's stamp is actually stale).
    await new Promise((r) => setTimeout(r, 1_100));
    expect((await zendeskPutTicket(world, SEED.ticketId, { priority: "high" })).status).toBe(200);
    const count = (await getComments(world, SEED.ticketId)).length;

    const stale = await zendeskPutTicket(world, SEED.ticketId, {
      comment: { body: "should not land", public: false },
      safe_update: true,
      updated_stamp: stampBefore,
    });
    expect(stale.status).toBe(409);
    expect(await getComments(world, SEED.ticketId)).toHaveLength(count);

    const fresh = await zendeskPutTicket(world, SEED.ticketId, {
      comment: { body: "guarded private note", public: false },
      safe_update: true,
      updated_stamp: (await getTicket(world, SEED.ticketId)).updated_at,
    });
    expect(fresh.status).toBe(200);
    const comments = await getComments(world, SEED.ticketId);
    expect(comments).toHaveLength(count + 1);
    expect(comments.at(-1)).toMatchObject({ body: "guarded private note", public: false });
  });

  // Surprise: the seeded comment thread is re-spread across the ticket's created→updated window
  // on ANY update to that ticket, so earlier comments' created_at change. A readset fingerprint
  // that includes comment timestamps would raise a false stale hold after our own write.
  it("documents: any ticket update rewrites the seeded comments' created_at", async () => {
    const before = await getComments(world, THIRD_TICKET);
    expect((await zendeskPutTicket(world, THIRD_TICKET, { priority: "high" })).status).toBe(200);
    const after = await getComments(world, THIRD_TICKET);
    expect(after.map(stable)).toEqual(before.map(stable));
    expect(after.map((c) => c.created_at)).not.toEqual(before.map((c) => c.created_at));
    expect(after[0]?.created_at).toBe(before[0]?.created_at);
  });

  it("documents the default: a REST comment without `public` is public", async () => {
    const res = await zendeskPutTicket(world, SEED.otherTicketId, {
      comment: { body: "visibility not specified" },
    });
    expect(res.status).toBe(200);
    expect((await getComments(world, SEED.otherTicketId)).at(-1)?.public).toBe(true);
  });
});
