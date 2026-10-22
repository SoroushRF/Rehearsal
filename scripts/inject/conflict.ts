import { bind, DEMO, getJson, report, vendorFetch } from "./session";

/**
 * The teammate trap: someone changes a cohort ticket's priority in the operational world through
 * the ordinary vendor API. Inject is the wrong tool here; it rebuilds the record.
 * Pass the value with `--priority=urgent`; it defaults to urgent. Run `pnpm demo:reset` first.
 */

type Ticket = { ticket: { id: number; priority: string | null; updated_at: string } };

const arg = process.argv.find((value) => value.startsWith("--priority="));
const priority = arg ? arg.slice("--priority=".length) : "urgent";
const path = `/api/v2/tickets/${DEMO.conflict.ticketId}.json`;

const world = await bind("zendesk", "operational");
const planningWorld = await bind("zendesk", "planning");
const before = await getJson<Ticket>("zendesk", world, path);
const planningBefore = await getJson<Ticket>("zendesk", planningWorld, path);
const write = await vendorFetch("zendesk", world, path, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ticket: { priority } }),
});
const after = await getJson<Ticket>("zendesk", world, path);
const planningAfter = await getJson<Ticket>("zendesk", planningWorld, path);

report([
  [write.ok, `teammate PUT ticket ${DEMO.conflict.ticketId} → ${write.status}`],
  [
    after.ticket.priority === priority,
    `operational priority ${before.ticket.priority} → ${after.ticket.priority}`,
  ],
  [
    after.ticket.updated_at !== before.ticket.updated_at,
    "operational updated_at moved, so a stale safe_update stamp will 409",
  ],
  [
    planningAfter.ticket.priority === planningBefore.ticket.priority,
    `planning world unchanged at ${planningAfter.ticket.priority}`,
  ],
]);
