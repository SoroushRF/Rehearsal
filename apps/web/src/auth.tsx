import {
  ClerkProvider,
  OrganizationSwitcher,
  Show,
  SignInButton,
  UserButton,
  useAuth,
} from "@clerk/react";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useCallback } from "react";
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
    colorPrimary: "#4338ca",
    colorText: "#0e1626",
    colorTextSecondary: "#465065",
    borderRadius: "0.5rem",
    fontFamily: '"Inter Variable", ui-sans-serif, system-ui, sans-serif',
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

/** Clerk role and permissions as the API verified them. */
export function VerifiedIdentity({
  clerkRole,
  permissions,
}: {
  clerkRole: string | null;
  permissions: readonly string[];
}) {
  return (
    <span data-testid="verified-identity" className="flex max-w-xl flex-wrap items-center gap-1.5">
      <Badge tone="info" icon="users" hint="Clerk organization role verified by the API">
        {clerkRole ?? "No role"}
      </Badge>
      <span data-testid="verified-permissions" className="text-xs leading-4 text-muted">
        {permissions.length > 0 ? permissions.join(", ") : "No permissions"}
      </span>
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
        <OrganizationSwitcher hidePersonal />
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
  return <VerifiedIdentity clerkRole={me.data.clerkRole} permissions={me.data.permissions} />;
}
