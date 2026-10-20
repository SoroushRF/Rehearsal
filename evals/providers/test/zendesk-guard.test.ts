import type { WorldConfig } from "@rehearsal/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ENABLED,
  getTicket,
  resetScratchTenants,
  SEED,
  scratchWorld,
  uniqueTenant,
  type ZendeskTicket,
  zendeskPutTicket,
} from "../src/harness";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function put(world: WorldConfig, id: number, ticket: Record<string, unknown>) {
  const res = await zendeskPutTicket(world, id, ticket);
  const body = (await res.json()) as {
    ticket?: ZendeskTicket;
    error?: string;
    description?: string;
  };
  return { status: res.status, body };
}

// Gate 4: REST safe_update + updated_stamp is a real precondition, but updated_at has whole-second
// precision. It is a native guard with documented limits, not a unique CAS version.
describe.skipIf(!ENABLED)("Zendesk guarded ticket update", () => {
  let world: WorldConfig;

  beforeAll(async () => {
    world = await scratchWorld("zendesk", "planning", uniqueTenant("guard"));
  });

  afterAll(resetScratchTenants);

  it("accepts a fresh stamp, then refuses the now-stale one with 409", async () => {
    const seen = await getTicket(world, SEED.ticketId);
    expect(seen.priority).not.toBe("high");

    const ok = await put(world, SEED.ticketId, {
      priority: "high",
      safe_update: true,
      updated_stamp: seen.updated_at,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.ticket?.priority).toBe("high");
    expect(ok.body.ticket?.updated_at).not.toBe(seen.updated_at);

    const stale = await put(world, SEED.ticketId, {
      priority: "low",
      safe_update: true,
      updated_stamp: seen.updated_at,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("UpdateConflict");

    const after = await getTicket(world, SEED.ticketId);
    expect(after.priority).toBe("high");
    expect(after.updated_at).toBe(ok.body.ticket?.updated_at);
  });

  it("requires a stamp when safe_update is set", async () => {
    const res = await put(world, SEED.ticketId, { priority: "low", safe_update: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ParameterMissing");
  });

  it("catches a teammate edit made at least a second after our read", async () => {
    const ours = await put(world, SEED.otherTicketId, { priority: "normal" });
    const stamp = ours.body.ticket?.updated_at;
    await sleep(1_100);
    expect((await put(world, SEED.otherTicketId, { priority: "urgent" })).status).toBe(200);

    const guarded = await put(world, SEED.otherTicketId, {
      priority: "low",
      safe_update: true,
      updated_stamp: stamp,
    });
    expect(guarded.status).toBe(409);
    expect((await getTicket(world, SEED.otherTicketId)).priority).toBe("urgent");
  });

  // LIMITATION, asserted so it can't silently be forgotten: a teammate write in the same
  // simulated second as our read leaves updated_at unchanged, so our "guarded" write with the
  // stamp we read passes and overwrites the teammate. Executors must label this guard
  // native_guard_with_documented_limits and still compare the relevant projection.
  it("does NOT catch a teammate edit in the same second (1-second stamp collision)", async () => {
    let collided = false;
    for (let attempt = 0; attempt < 10 && !collided; attempt++) {
      const ours = await put(world, SEED.otherTicketId, { priority: "normal" });
      const stamp = ours.body.ticket?.updated_at;
      const teammate = await put(world, SEED.otherTicketId, { priority: "urgent" });
      if (teammate.body.ticket?.updated_at !== stamp) {
        await sleep(50); // crossed a second boundary; try again
        continue;
      }
      collided = true;
      const guarded = await put(world, SEED.otherTicketId, {
        priority: "low",
        safe_update: true,
        updated_stamp: stamp,
      });
      expect(guarded.status).toBe(200);
      expect((await getTicket(world, SEED.otherTicketId)).priority).toBe("low");
    }
    expect(collided, "never produced two writes in one simulated second").toBe(true);
  });
});
