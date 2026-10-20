import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  eraAdmin,
  eraFetch,
  mintTenantToken,
  resolveWorld,
  type WorldConfig,
} from "@rehearsal/providers";

/**
 * Copies real GET responses from a fresh planning-world tenant into scenarios/billing/fixtures/
 * as inject templates. Stripe inject does not complete partial objects, so templates must start
 * from a complete vendor response. Re-run after changing the image pin, then commit the diff.
 * The providers conformance suite fails if these drift from the pinned images.
 */
const CAPTURES = [
  ["stripe", "/v1/charges/ch_7wD2ja8lIorW65Uh", "stripe.charge.json"],
  ["zendesk", "/api/v2/tickets/4000000.json", "zendesk.ticket.json"],
] as const;

const adminToken = process.env.ERA_ADMIN_TOKEN;
if (!adminToken) throw new Error("ERA_ADMIN_TOKEN is not set (copy .env.example to .env)");
const dir = fileURLToPath(new URL("../../scenarios/billing/fixtures/", import.meta.url));

for (const [vendor, path, file] of CAPTURES) {
  const base: WorldConfig = { ...resolveWorld(vendor, "planning"), tenant: "fixture-capture" };
  const world = { ...base, tenantToken: (await mintTenantToken(base, adminToken)).token };
  await eraAdmin(world, adminToken, "/reset");
  const res = await eraFetch(world, path, { headers: { authorization: "Bearer sk_test_capture" } });
  if (!res.ok) throw new Error(`${vendor} GET ${path} → ${res.status}`);
  writeFileSync(`${dir}${file}`, `${JSON.stringify(await res.json(), null, 2)}\n`);
  await eraAdmin(world, adminToken, "/reset");
  console.log(`wrote ${dir}${file}`);
}
