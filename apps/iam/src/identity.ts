import { permissionsFor } from "@rehearsal/authz";
import { type AuthzRuleFile, IdentityRequest, type IdentityResult } from "@rehearsal/contracts";
import type { ClerkVerifier } from "./clerk";
import { ruleKey } from "./rules";

/**
 * Who is holding this session token, and which permissions the named rule file gives that Clerk
 * role. There is no action and no resource: `GET /api/me` is not a product rule. A token IAM
 * cannot verify is not a person.
 */
export async function answerIdentity(
  raw: unknown,
  deps: { files: ReadonlyMap<string, AuthzRuleFile>; clerk: ClerkVerifier },
): Promise<IdentityResult> {
  const parsed = IdentityRequest.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "unauthenticated" };
  const file = deps.files.get(ruleKey(parsed.data.rule.id, parsed.data.rule.version));
  if (!file) return { ok: false, error: "unknown_rule" };
  const person = await deps.clerk.verify(parsed.data.token);
  if (!person?.sessionId) return { ok: false, error: "unauthenticated" };
  if (!person.orgId) return { ok: false, error: "no_active_organization" };
  return {
    ok: true,
    userId: person.userId,
    orgId: person.orgId,
    clerkRole: person.orgRole,
    permissions: permissionsFor(file, person.orgRole),
    sessionId: person.sessionId,
  };
}
