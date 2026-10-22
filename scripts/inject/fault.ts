import { bind, DEMO, faults, report, vendorFetch } from "./session";

/**
 * Era throttling on the operational Stripe container: the next request gets a 429 with
 * Retry-After, the one after it succeeds. Faults are cleared before exiting.
 * Faults are container-wide, so do not run this while another test uses that world.
 */

const world = await bind("stripe", "operational");
const path = `/v1/charges/${DEMO.phantom.chargeIds[0]}`;

await faults(world, { fail_next: 1, retry_after_seconds: 1 });
try {
  const throttled = await vendorFetch("stripe", world, path);
  const retried = await vendorFetch("stripe", world, path);
  report([
    [throttled.status === 429, `first request → ${throttled.status}`],
    [
      throttled.headers.get("retry-after") !== null,
      `Retry-After: ${throttled.headers.get("retry-after")}`,
    ],
    [retried.ok, `next request → ${retried.status}`],
  ]);
} finally {
  await faults(world, null);
}
