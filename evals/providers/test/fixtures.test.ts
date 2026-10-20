import { readFileSync } from "node:fs";
import { eraAdmin, type WorldConfig } from "@rehearsal/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminToken,
  ENABLED,
  getComments,
  getJson,
  getTicket,
  resetScratchTenants,
  SEED,
  scratchWorld,
  uniqueTenant,
} from "../src/harness";

const FIXTURES = new URL("../../../scenarios/billing/fixtures/", import.meta.url);
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as Record<string, unknown>;

// The inject templates in scenarios/billing/fixtures are verbatim GET responses. They must still
// match the pinned images, and a record derived from them must inject and read back.
describe.skipIf(!ENABLED)("inject fixture templates", () => {
  let stripe: WorldConfig;
  let zendesk: WorldConfig;

  beforeAll(async () => {
    const tenant = uniqueTenant("fixtures");
    stripe = await scratchWorld("stripe", "planning", tenant);
    zendesk = await scratchWorld("zendesk", "planning", tenant);
  });

  afterAll(resetScratchTenants);

  it("match a fresh tenant's GET responses (re-run pnpm fixtures:capture if not)", async () => {
    expect(await getJson("stripe", stripe, `/v1/charges/${SEED.chargeId}`)).toEqual(
      fixture("stripe.charge.json"),
    );
    expect(await getJson("zendesk", zendesk, `/api/v2/tickets/${SEED.ticketId}.json`)).toEqual(
      fixture("zendesk.ticket.json"),
    );
  });

  it("inject a complete Stripe charge derived from the template", async () => {
    const charge: Record<string, unknown> = {
      ...fixture("stripe.charge.json"),
      id: "ch_rehearsalInject01",
      amount: 4210,
      amount_captured: 4210,
    };
    const res = await eraAdmin(stripe, adminToken(), "/inject", { charges: [charge] });
    expect(res.status).toBe(200);
    // Read back verbatim, except the nested refunds list URL, which Stripe re-derives from the id.
    expect(await getJson("stripe", stripe, "/v1/charges/ch_rehearsalInject01")).toEqual({
      ...charge,
      refunds: {
        ...(charge.refunds as Record<string, unknown>),
        url: "/v1/charges/ch_rehearsalInject01/refunds",
      },
    });

    const listed = await getJson<{ data: Array<{ id: string }> }>(
      "stripe",
      stripe,
      `/v1/charges?customer=${charge.customer as string}&limit=100`,
    );
    expect(listed.data.map((c) => c.id)).toContain("ch_rehearsalInject01");
  });

  it("inject a Zendesk ticket derived from the template, with an explicit thread", async () => {
    const { ticket: template } = fixture("zendesk.ticket.json") as {
      ticket: Record<string, unknown>;
    };
    const ticket = {
      ...template,
      id: 90005531,
      external_id: "incident-812",
      subject: "Billing incident INV-812",
      // Derived fields are echoed as given, not recomputed: rewrite them with the identity.
      url: "https://northwind.zendesk.com/api/v2/tickets/90005531.json",
      raw_subject: "Billing incident INV-812",
      description: "Duplicate charge on my invoice",
      comments: [{ body: "Duplicate charge on my invoice", public: true }],
    };
    const res = await eraAdmin(zendesk, adminToken(), "/inject", { tickets: [ticket] });
    expect(res.status).toBe(200);

    const read = await getTicket(zendesk, 90005531);
    expect(read).toMatchObject({
      id: 90005531,
      external_id: "incident-812",
      subject: "Billing incident INV-812",
      url: ticket.url,
      raw_subject: ticket.raw_subject,
    });
    const comments = await getComments(zendesk, 90005531);
    expect(comments.map((c) => [c.body, c.public])).toContainEqual([
      "Duplicate charge on my invoice",
      true,
    ]);
  });
});
