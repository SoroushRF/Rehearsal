import {
  ClerkProvider,
  OrganizationSwitcher,
  Show,
  SignInButton,
  UserButton,
  useAuth,
  useOrganization,
  useOrganizationList,
} from "@clerk/react";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { z } from "zod";
import type { ApiFetch } from "./api";
import { Badge } from "./components/Badge";
import { Button } from "./components/ui";
import { identityOf, useTenantKey } from "./identity";

/** Without a publishable key the app runs read-only on fixtures: no sign-in, no commands. */
export const clerkKey: string | undefined = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY || undefined;

/** Clerk's own components (sign-in, user menu, org switcher) follow the app's colors and type. */
const clerkAppearance = {
  variables: {
    colorPrimary: "#2238b8",
    colorPrimaryForeground: "#ffffff",
    colorText: "#12161b",
    colorTextSecondary: "#434a52",
    borderRadius: "0.25rem",
    fontFamily: '"Archivo Variable", ui-sans-serif, system-ui, sans-serif',
    fontSize: "0.9375rem",
  },
  elements: { organizationSwitcherTrigger: { padding: "0.25rem 0.5rem" } },
} as const;

export function AuthProvider({ children }: { children: ReactNode }) {
  return clerkKey ? (
    <ClerkProvider publishableKey={clerkKey} appearance={clerkAppearance}>
      {children}
    </ClerkProvider>
  ) : (
    children
  );
}

/**
 * `fetch` for the API with the Clerk session token as a bearer header. The API ignores Clerk's
 * cookie, so this is the only way a request carries the reviewer's identity.
 */
export function useApiFetch() {
  const { getToken } = useAuth();
  return useCallback(
    async (path: string, init: RequestInit = {}) => {
      const token = await getToken();
      const headers = new Headers(init.headers);
      if (token) headers.set("authorization", `Bearer ${token}`);
      return fetch(path, { ...init, headers });
    },
    [getToken],
  );
}

/** `GET /api/me`: the person IAM verified, their Clerk role, and the permissions that role holds. */
export const Me = z.object({
  userId: z.string(),
  orgId: z.string(),
  clerkRole: z.string().nullable(),
  permissions: z.array(z.string()),
});
export type Me = z.infer<typeof Me>;

/** A missing or refused `/api/me` is no permission list. A 200 is parsed. */
export async function loadMe(apiFetch: ApiFetch): Promise<Me | null> {
  const res = await apiFetch("/api/me");
  if (!res.ok) return null;
  return Me.parse(await res.json());
}

/**
 * Permissions for the plan page. Keyed by the signed-in identity, so switching organization
 * refetches `/api/me` instead of keeping the previous org's list.
 */
export function usePermissions(apiFetch: ApiFetch): {
  permissions: readonly string[] | null;
  ready: boolean;
} {
  const key = useTenantKey();
  const me = useQuery({
    queryKey: key("me"),
    retry: false,
    queryFn: () => loadMe(apiFetch),
  });
  return { permissions: me.data?.permissions ?? null, ready: me.isFetched };
}

/** Clerk role as the API verified it. Permission identifiers stay on `/api/me` for gating. */
export function VerifiedIdentity({ clerkRole }: { clerkRole: string | null }) {
  return (
    <span data-testid="verified-identity" className="flex max-w-xl flex-wrap items-center gap-1.5">
      <Badge tone="info" icon="users" hint="Clerk organization role verified by the API">
        {clerkRole ?? "No role"}
      </Badge>
    </span>
  );
}

export function AccountBar() {
  if (!clerkKey) {
    return (
      <Badge
        tone="warn"
        icon="eye"
        hint="Sign-in isn't configured here, so plans are read-only fixtures."
      >
        Read-only fixtures
      </Badge>
    );
  }
  return (
    <div className="flex items-center gap-2.5 sm:gap-3">
      <Show when="signed-out">
        <SignInButton mode="modal">
          <Button variant="primary" size="sm">
            Sign in
          </Button>
        </SignInButton>
      </Show>
      <Show when="signed-in">
        <VerifiedRoles />
        <OneOrganization />
        <UserButton />
      </Show>
    </div>
  );
}

/** Clerk role and permissions as the API verified them, not as the browser believes them. */
function VerifiedRoles() {
  const { userId, orgId } = useAuth();
  const apiFetch = useApiFetch();
  const me = useQuery({
    // Keyed by the verified user and org, so switching organization refetches /api/me.
    queryKey: ["tenant", orgId && userId ? identityOf(userId, orgId) : "none", "me"],
    enabled: Boolean(userId && orgId),
    retry: false,
    queryFn: async () => {
      const res = await apiFetch("/api/me");
      if (res.status === 401) return null;
      if (!res.ok) throw new Error(`/api/me returned ${res.status}`);
      return Me.parse(await res.json());
    },
  });

  if (!orgId) return <Badge tone="warn">Choose an organization</Badge>;
  if (me.isPending) return <span className="text-xs text-subtle">checking permissions…</span>;
  if (me.isError || me.data === null) return <Badge tone="danger">Permissions not verified</Badge>;
  return <VerifiedIdentity clerkRole={me.data.clerkRole} />;
}

/**
 * Header slot for the signed-in person's organization.
 * `membershipCount === null` means the list is still loading, so nothing is rendered and the
 * create switcher cannot flash. Zero memberships keep Clerk's switcher, which is how they
 * create or accept the first organization. After that, the name is text: no switcher and no
 * create action, including when they already belong to more than one.
 */
export function OrganizationControl({
  membershipCount,
  activeOrganizationName,
}: {
  membershipCount: number | null;
  activeOrganizationName: string | null;
}) {
  if (membershipCount === null) return null;
  if (membershipCount < 1) return <OrganizationSwitcher hidePersonal />;
  return (
    <span data-testid="active-organization" className="max-w-xs truncate text-sm font-medium">
      {activeOrganizationName}
    </span>
  );
}

/**
 * One person is in one organization. When they have exactly one membership and it is not
 * active, activate it once so the header is not stuck on "Choose an organization" with no
 * switcher. A second organization is never offered here.
 */
function OneOrganization() {
  const { organization, isLoaded: organizationLoaded } = useOrganization();
  const { isLoaded, setActive, userMemberships } = useOrganizationList({
    userMemberships: true,
  });
  const activated = useRef(false);
  const memberships = userMemberships.data ?? [];
  const membershipCount = membershipCountOf(
    isLoaded,
    userMemberships.isLoading,
    userMemberships.isFetching,
    userMemberships.count,
    memberships.length,
  );
  const soleOrganizationId = membershipCount === 1 ? memberships[0]?.organization.id : undefined;

  useEffect(() => {
    if (membershipCount !== 1 || !organizationLoaded || !setActive || !soleOrganizationId) return;
    if (organization?.id === soleOrganizationId || activated.current) return;
    activated.current = true;
    void setActive({ organization: soleOrganizationId }).catch(() => {
      // One attempt. Retrying while the membership stays inactive would loop.
    });
  }, [membershipCount, organizationLoaded, setActive, soleOrganizationId, organization?.id]);

  const activeOrganizationName =
    organization?.name ??
    (membershipCount === 1 ? (memberships[0]?.organization.name ?? null) : null);

  return (
    <OrganizationControl
      membershipCount={membershipCount}
      activeOrganizationName={activeOrganizationName}
    />
  );
}

/** `null` until the membership list has settled, so an empty page is not treated as zero memberships. */
function membershipCountOf(
  isLoaded: boolean,
  isLoading: boolean,
  isFetching: boolean,
  count: number | undefined,
  loadedLength: number,
): number | null {
  if (!isLoaded || isLoading) return null;
  if (loadedLength === 0 && isFetching) return null;
  if (typeof count === "number") return count;
  return loadedLength;
}
