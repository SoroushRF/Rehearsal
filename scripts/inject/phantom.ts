import { adminOrThrow, bind, fixture, getJson, report, SEED, WINDOW } from "./session";

/**
 * The phantom trap: after approval, a duplicate charge appears for the customer inside the
 * incident window, in the operational world only. A charge for another customer is the
 * control and must not enter this customer's query.
 */

const PHANTOM = "ch_rehearsalPhantom01";
const CONTROL = "ch_rehearsalControl01";
const CONTROL_CUSTOMER = "cus_rehearsalControl01";
const CREATED = Date.parse("2026-09-25T00:00:00.000Z") / 1000;

function duplicate(id: string, customer: string): Record<string, unknown> {
  return {
    ...fixture("stripe.charge.json"),
    id,
    customer,
    created: CREATED,
    payment_intent: `pi_${id.slice(3)}`,
    balance_transaction: `txn_${id.slice(3)}`,
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
  charges: [duplicate(PHANTOM, SEED.customerId), duplicate(CONTROL, CONTROL_CUSTOMER)],
});

const now = await getJson<ChargeList>("stripe", operational, windowQuery(SEED.customerId));
const planned = await getJson<ChargeList>("stripe", planning, windowQuery(SEED.customerId));
const original = await getJson<{ id: string; amount_refunded: number }>(
  "stripe",
  operational,
  `/v1/charges/${SEED.chargeId}`,
);
const ids = now.data.map((charge) => charge.id);

report([
  [!now.has_more, "operational window query fetched every page"],
  [ids.includes(PHANTOM), `${PHANTOM} now matches ${SEED.customerId} in the window`],
  [!ids.includes(CONTROL), `${CONTROL} (another customer) does not match`],
  [
    !planned.data.some((charge) => charge.id === PHANTOM),
    "planning world is unchanged: the agent never saw the phantom",
  ],
  [
    original.amount_refunded === 0,
    `${SEED.chargeId} itself is unchanged, so only re-running the query catches this`,
  ],
]);
