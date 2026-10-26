import { createHash } from "node:crypto";

/**
 * Live demo: each org gets its own Era tenant in the planning and operational worlds, so one
 * org's apply never changes another org's data. Derived, never stored; seeding is idempotent.
 */
export function orgTenant(orgId: string): string {
  return `org-${createHash("sha256").update(orgId).digest("hex").slice(0, 12)}`;
}
