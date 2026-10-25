/**
 * What the signed-in person may do, from `GET /api/me`. The server still decides.
 * `null` means this page has no verified list (a fixture harness that doesn't serve `/api/me`):
 * the controls that were always on screen stay, and the new ones stay hidden.
 */
const ANY_OF = {
  approve: ["rehearsal:approve:support_step", "rehearsal:approve:finance_step"],
  apply: ["rehearsal:apply:plan"],
  cancel: ["rehearsal:cancel:run"],
  revoke: ["rehearsal:revoke:own_grant", "rehearsal:revoke:any_grant"],
  rehearse: ["rehearsal:rehearse:incident"],
  invite: ["rehearsal:invite:member"],
  manageRole: ["rehearsal:manage:role"],
} as const;

export type GatedAction = keyof typeof ANY_OF;

/** Shown even when `/api/me` isn't available, because the review page always had them. */
const SHOW_WHEN_UNKNOWN: Record<GatedAction, boolean> = {
  approve: true,
  apply: true,
  cancel: false,
  revoke: false,
  rehearse: true,
  invite: false,
  manageRole: false,
};

export function actionAllowed(permissions: readonly string[] | null, action: GatedAction): boolean {
  if (permissions === null) return SHOW_WHEN_UNKNOWN[action];
  return ANY_OF[action].some((permission) => permissions.includes(permission));
}

/** Clerk organization roles the rule file maps. The body sends one of these and never an org. */
export const ORG_ROLES = [
  "org:owner",
  "org:finance_lead",
  "org:support_lead",
  "org:member",
] as const;
export type OrgRoleName = (typeof ORG_ROLES)[number];

/** The two approval seats, as the API names them on `signed.permission`. */
export const APPROVAL_SEATS = [
  {
    seat: "support_lead",
    permission: "rehearsal:approve:support_step",
    label: "Support lead",
  },
  {
    seat: "finance_lead",
    permission: "rehearsal:approve:finance_step",
    label: "Finance lead",
  },
] as const;
