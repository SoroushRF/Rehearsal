import { eraMeta, type WorldConfig } from "@rehearsal/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ENABLED,
  getJson,
  SEED,
  startReadOnlySimulator,
  stripePost,
  zendeskPutTicket,
} from "../src/harness";

// Gate 1: writes are on only because we asked. The same pinned image without
// SIMCORE_ALLOW_CLIENT_WRITES must refuse a client mutation and leave the data alone.
describe.skipIf(!ENABLED)("read-only refusal control", () => {
  const stops: Array<() => Promise<void>> = [];
  let stripe: WorldConfig;
  let zendesk: WorldConfig;

  beforeAll(async () => {
    const [s, z] = await Promise.all([
      startReadOnlySimulator("stripe"),
      startReadOnlySimulator("zendesk"),
    ]);
    stops.push(s.stop, z.stop);
    stripe = { baseUrl: s.baseUrl, tenant: "default" };
    zendesk = { baseUrl: z.baseUrl, tenant: "default" };
  });

  afterAll(async () => {
    await Promise.all(stops.map((stop) => stop()));
  });

  it("reports writes disabled in /_meta", async () => {
    expect((await eraMeta(stripe)).writes?.allowed).toBe(false);
    expect((await eraMeta(zendesk)).writes?.allowed).toBe(false);
  });

  it("Stripe refuses a refund with 403 in Stripe's own error envelope", async () => {
    const res = await stripePost(stripe, "/v1/refunds", `charge=${SEED.chargeId}&amount=100`);
    expect(res.status).toBe(403);
    // Stripe wraps the shared writes_disabled refusal in its vendor envelope; the code string
    // itself does not appear, so match the message.
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toMatch(/read-only/);
    expect(body.error.message).toMatch(/SIMCORE_ALLOW_CLIENT_WRITES/);

    const charge = await getJson<{ amount_refunded: number }>(
      "stripe",
      stripe,
      `/v1/charges/${SEED.chargeId}`,
    );
    expect(charge.amount_refunded).toBe(0);
  });

  it("Zendesk refuses a ticket update with 403 writes_disabled", async () => {
    const before = await getJson<{ ticket: { priority: string } }>(
      "zendesk",
      zendesk,
      `/api/v2/tickets/${SEED.ticketId}.json`,
    );
    const res = await zendeskPutTicket(zendesk, SEED.ticketId, { priority: "urgent" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "writes_disabled" });

    const after = await getJson<{ ticket: { priority: string } }>(
      "zendesk",
      zendesk,
      `/api/v2/tickets/${SEED.ticketId}.json`,
    );
    expect(after.ticket.priority).toBe(before.ticket.priority);
  });
});
