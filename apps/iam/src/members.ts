import { decide } from "@rehearsal/authz";
import { type AuthzRuleFile, MembershipCommand, type MembershipResult } from "@rehearsal/contracts";
import type { ClerkOrgClient, ClerkOrgMembership, ClerkVerifier } from "./clerk";
import { ruleKey } from "./rules";

const INVITE = "POST /api/members/invitations";
const SET_ROLE = "PATCH /api/members/:userId/role";

/**
 * Performs a Clerk membership write after verifying the session token again. The organization
 * is the one on that token. The API's client certificate is not enough: the same permission the
 * route asked about is checked here, and a role Clerk knows but the rule file does not map is
 * refused before Clerk is asked to write.
 */
export async function answerMembership(
  raw: unknown,
  deps: {
    files: ReadonlyMap<string, AuthzRuleFile>;
    clerk: ClerkVerifier;
    orgs?: ClerkOrgClient;
  },
): Promise<MembershipResult> {
  const parsed = MembershipCommand.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "bad_request" };
  const command = parsed.data;
  const file = deps.files.get(ruleKey(command.rule.id, command.rule.version));
  if (!file) return { ok: false, error: "unknown_rule" };

  const person = await deps.clerk.verify(command.token);
  if (!person?.sessionId) return { ok: false, error: "unauthenticated" };
  if (!person.orgId) return { ok: false, error: "no_active_organization" };

  const action = command.kind === "invite" ? INVITE : SET_ROLE;
  const decision = decide({
    file,
    action,
    subject: { userId: person.userId, orgId: person.orgId, clerkRole: person.orgRole },
    resource: { orgId: person.orgId },
    now: new Date(),
  });
  if (decision.effect !== "allow") return { ok: false, error: "forbidden" };
  if (!Object.hasOwn(file.rolesFromClerk, command.role)) {
    return { ok: false, error: "invalid_role" };
  }
  if (!deps.orgs) return { ok: false, error: "clerk_unavailable" };

  try {
    if (command.kind === "invite") {
      await deps.orgs.createInvitation({
        organizationId: person.orgId,
        emailAddress: command.email,
        role: command.role,
        inviterUserId: person.userId,
      });
      return {
        ok: true,
        kind: "invite",
        orgId: person.orgId,
        role: command.role,
        email: command.email,
      };
    }

    const memberships = await deps.orgs.listMemberships(person.orgId);
    const target = memberships.find((member) => member.userId === command.userId);
    if (!target) return { ok: false, error: "member_not_found" };
    if (removesLastOwner(file, memberships, target.role, command.role)) {
      return { ok: false, error: "last_owner" };
    }
    await deps.orgs.updateMembershipRole({
      organizationId: person.orgId,
      userId: command.userId,
      role: command.role,
    });
    return {
      ok: true,
      kind: "set_role",
      orgId: person.orgId,
      role: command.role,
      userId: command.userId,
    };
  } catch {
    return { ok: false, error: "clerk_unavailable" };
  }
}

/** Clerk roles in the rule file that map to owner. Any other role is not an owner seat. */
function ownerClerkRoles(file: AuthzRuleFile): Set<string> {
  return new Set(
    Object.entries(file.rolesFromClerk)
      .filter(([, orgRole]) => orgRole === "owner")
      .map(([clerkRole]) => clerkRole),
  );
}

/**
 * True when this change takes the owner role off someone and nobody else still holds it.
 * Keeping the same owner role, or changing anyone who is not an owner, is not a removal.
 */
function removesLastOwner(
  file: AuthzRuleFile,
  memberships: readonly ClerkOrgMembership[],
  currentRole: string,
  nextRole: string,
): boolean {
  const owners = ownerClerkRoles(file);
  if (!owners.has(currentRole) || owners.has(nextRole)) return false;
  return memberships.filter((member) => owners.has(member.role)).length <= 1;
}
