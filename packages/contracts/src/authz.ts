import { z } from "zod";

/**
 * Wire types for IAM (decision 0014). The app asks; IAM answers. These schemas are the question,
 * the answer, and the versioned rule file. They do not know refunds, tickets, or amounts.
 *
 * `Role` in `common.ts` is the seat stamped on a plan step. `OrgRole` is organization membership.
 * A grant keeps `roles` so older rows still parse, and may also record the permissions and the
 * rule version those permissions were copied from.
 */

/** `rehearsal:<verb>:<object>`, lowercase letters and underscores. Open for a later version. */
export const Permission = z
  .string()
  .regex(/^rehearsal:[a-z_]+:[a-z_]+$/, "expected rehearsal:<verb>:<object>");
export type Permission = z.infer<typeof Permission>;

/** The permissions a v1 rule file and a grant may name. Adding one is a new file version. */
export const PERMISSIONS_V1 = [
  "rehearsal:read:plan",
  "rehearsal:read:run",
  "rehearsal:rehearse:incident",
  "rehearsal:revise:plan",
  "rehearsal:approve:support_step",
  "rehearsal:approve:finance_step",
  "rehearsal:apply:plan",
  "rehearsal:cancel:run",
  "rehearsal:revoke:own_grant",
  "rehearsal:revoke:any_grant",
  "rehearsal:invite:member",
  "rehearsal:manage:role",
] as const;

export const PermissionV1 = z.enum(PERMISSIONS_V1);
export type PermissionV1 = z.infer<typeof PermissionV1>;

/** Membership in an organization. Not the `Role` stamped on a plan step. */
export const OrgRole = z.enum(["owner", "finance_lead", "support_lead", "member"]);
export type OrgRole = z.infer<typeof OrgRole>;

/**
 * A path (`subject.orgId`) or a literal (`"true"`, `"false"`). Both sides of a comparison are
 * strings in the file; the engine interprets them. Not a number or a boolean.
 */
const attribute = z.string().min(1);
const attributePair = z.tuple([attribute, attribute]);

/**
 * One check is one key. The file has no shared discriminator, so this is a union of strict
 * single-key objects. `some` and `seats` nest the same checks. The check `allOf` is two paths,
 * distinct from `rbac.allOf`, which is one path into a list the app sends.
 */
export type AuthzCheck =
  | { eq: [string, string] }
  | { gt: [string, string] }
  | { isNull: string }
  | { some: { in: string; where: AuthzCheck[] } }
  | {
      seats: {
        in: string;
        where: AuthzCheck[];
        fill: PermissionV1[];
        distinct: string;
      };
    }
  | { allOf: [string, string] };

export const AuthzCheck: z.ZodType<AuthzCheck> = z.lazy(() =>
  z.union([
    z.strictObject({ eq: attributePair }),
    z.strictObject({ gt: attributePair }),
    z.strictObject({ isNull: attribute }),
    z.strictObject({
      some: z.strictObject({
        in: attribute,
        where: z.array(AuthzCheck),
      }),
    }),
    z.strictObject({
      seats: z.strictObject({
        in: attribute,
        where: z.array(AuthzCheck),
        fill: z.array(PermissionV1).min(1),
        distinct: attribute,
      }),
    }),
    z.strictObject({ allOf: attributePair }),
  ]),
);

/**
 * `anyOf`: the subject holds at least one listed permission.
 * `allOf`: one path to a permission list the app computed (a plan's `requiredPermissions`).
 * `{}`: no person, used by `run:admit`.
 */
export const AuthzRbac = z.union([
  z.strictObject({ anyOf: z.array(PermissionV1).min(1) }),
  z.strictObject({ allOf: attribute }),
  z.strictObject({}),
]);
export type AuthzRbac = z.infer<typeof AuthzRbac>;

export const AuthzRule = z.strictObject({
  action: z.string().min(1),
  rbac: AuthzRbac,
  abac: z.array(AuthzCheck),
});
export type AuthzRule = z.infer<typeof AuthzRule>;

/** The versioned rule file IAM loads. The caller names `id` and `version`; it does not send this. */
export const AuthzRuleFile = z.strictObject({
  id: z.string().min(1),
  version: z.int().positive(),
  /** Clerk organization role (`org:owner`) to one `OrgRole`. An unmapped Clerk role has no permissions. */
  rolesFromClerk: z.record(z.string().min(1), OrgRole),
  roles: z.strictObject({
    owner: z.array(PermissionV1).min(1),
    finance_lead: z.array(PermissionV1).min(1),
    support_lead: z.array(PermissionV1).min(1),
    member: z.array(PermissionV1).min(1),
  }),
  rules: z.array(AuthzRule),
});
export type AuthzRuleFile = z.infer<typeof AuthzRuleFile>;

/** Which rule file IAM must load. The caller cannot send the rule text. */
export const AuthzRuleRef = z.strictObject({
  id: z.string().min(1),
  version: z.int().positive(),
});
export type AuthzRuleRef = z.infer<typeof AuthzRuleRef>;

export const AuthzMode = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("person"), token: z.string().min(1) }),
  z.strictObject({ kind: z.literal("grants") }),
]);
export type AuthzMode = z.infer<typeof AuthzMode>;

/**
 * What the app asks. `resource` is facts the app read from stored rows (org, required permissions,
 * grants). IAM does not know which product fields those are.
 */
export const AuthzRequest = z.strictObject({
  action: z.string().min(1),
  rule: AuthzRuleRef,
  mode: AuthzMode,
  resource: z.record(z.string(), z.unknown()),
});
export type AuthzRequest = z.infer<typeof AuthzRequest>;

/**
 * IAM's answer. `resource` is the facts echoed back, so the caller can check the decision is about
 * the question it sent. A missing, timed-out, or malformed answer is a deny, decided by the caller.
 */
export const AuthzDecision = z.strictObject({
  effect: z.enum(["allow", "deny"]),
  action: z.string().min(1),
  rule: AuthzRuleRef,
  resource: z.record(z.string(), z.unknown()),
  reason: z.string().min(1),
});
export type AuthzDecision = z.infer<typeof AuthzDecision>;
