import { compareWorlds, seedIncident } from "../seed/incident";
import { ALL_WORLDS, adminOrThrow, bind, faults, report } from "./session";

/**
 * Clear faults, reset the demo tenant in all four worlds, and plant the INC-BILL-0927 cohort
 * identically in each (T1.2). Then check planning and operational read back the same.
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
    await seedIncident(vendor, bound);
    checks.push([true, `${label} faults cleared, tenant ${bound.tenant} reset and seeded`]);
  } catch (error) {
    checks.push([false, `${label}: ${(error as Error).message}`]);
  }
}
for (const vendor of ["stripe", "zendesk"] as const) {
  try {
    checks.push(
      await compareWorlds(
        vendor,
        await bind(vendor, "planning"),
        await bind(vendor, "operational"),
      ),
    );
  } catch (error) {
    checks.push([false, `${vendor} compare: ${(error as Error).message}`]);
  }
}
report(checks);
