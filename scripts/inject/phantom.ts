import { incidentRecords } from "@rehearsal/testkit";
import { adminOrThrow, bind, DEMO, getJson, report, WINDOW } from "./session";

/**
 * The phantom trap: after approval, another in-window duplicate charge appears for a cohort
 * customer, in the operational world only. A charge for the same customer outside the window is
 * the control and must not enter the incident query. Run `pnpm demo:reset` first.
 */

const target = DEMO.phantom;
const PHANTOM = `ch_INC0927${target.key}phantom`;
const CONTROL = `ch_INC0927${target.key}october`;

function copyOfDuplicate(id: string, createdIso: string): Record<string, unknown> {
  const template = incidentRecords().stripe.charges.find((c) => c.id === target.chargeIds[1]);
  if (!template) throw new Error(`cohort has no charge ${target.chargeIds[1]}`);
  return {
    ...template,
    id,
    created: Date.parse(createdIso) / 1000,
    payment_intent: `pi_${id.slice(3)}`,
    balance_transaction: `txn_${id.slice(3)}`,
    receipt_url: `https://pay.stripe.com/receipts/sim/${id}`,
    refunds: { object: "list", data: [], has_more: false, url: `/v1/charges/${id}/refunds` },
  };
}

type ChargeList = { data: Array<{ id: string }>; has_more: boolean };

function windowQuery(customer: string): string {
  const params = new URLSearchParams({
    customer,
    "created[gte]": String(WINDOW.createdGte),
    "created[lt]": String(WINDOW.createdLt),
    limit: "100",
  });
  return `/v1/charges?${params}`;
}

const operational = await bind("stripe", "operational");
const planning = await bind("stripe", "planning");

await adminOrThrow(operational, "/inject", {
  charges: [
    copyOfDuplicate(PHANTOM, "2026-09-25T09:00:00.000Z"),
    copyOfDuplicate(CONTROL, "2026-10-10T09:00:00.000Z"),
  ],
});

const now = await getJson<ChargeList>("stripe", operational, windowQuery(target.customerId));
const planned = await getJson<ChargeList>("stripe", planning, windowQuery(target.customerId));
const duplicate = await getJson<{ id: string; amount_refunded: number }>(
  "stripe",
  operational,
  `/v1/charges/${target.chargeIds[1]}`,
);
const ids = now.data.map((charge) => charge.id);

report([
  [!now.has_more, "operational window query fetched every page"],
  [ids.includes(PHANTOM), `${PHANTOM} now matches ${target.customerId} (${target.name})`],
  [!ids.includes(CONTROL), `${CONTROL} (October, outside the window) does not match`],
  [
    target.chargeIds.every((id) => ids.includes(id)),
    `the seeded charges ${target.chargeIds.join(", ")} still match`,
  ],
  [
    !planned.data.some((charge) => charge.id === PHANTOM),
    "planning world is unchanged: the agent never saw the phantom",
  ],
  [
    duplicate.amount_refunded === 0,
    `${target.chargeIds[1]} itself is unchanged, so only re-running the query catches this`,
  ],
]);
