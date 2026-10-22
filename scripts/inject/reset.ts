import { ALL_WORLDS, adminOrThrow, bind, faults, report } from "./session";

/**
 * Clear faults and reset the demo tenant in all four worlds, back to the image seed.
 * Never run this while an executor is applying: a reset forgets Stripe idempotency keys,
 * so a retry after it is a new refund.
 */
const checks: Array<[boolean, string]> = [];
for (const { vendor, world } of ALL_WORLDS) {
  const label = `${vendor}/${world}`;
  try {
    const bound = await bind(vendor, world);
    await faults(bound, null);
    await adminOrThrow(bound, "/reset");
    checks.push([true, `${label} faults cleared, tenant ${bound.tenant} reset`]);
  } catch (error) {
    checks.push([false, `${label}: ${(error as Error).message}`]);
  }
}
report(checks);
