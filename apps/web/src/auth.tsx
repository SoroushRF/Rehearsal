import {
  ClerkProvider,
  OrganizationSwitcher,
  Show,
  SignInButton,
  UserButton,
  useAuth,
} from "@clerk/react";
import { Role } from "@rehearsal/contracts";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useCallback } from "react";
import { z } from "zod";
import { Badge } from "./components/Badge";
import { Button } from "./components/ui";
import { roleLabel } from "./format";
import { identityOf } from "./identity";

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

const Me = z.object({ userId: z.string(), orgId: z.string(), roles: z.array(Role) });

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

/** Roles as the API verified them, not as the browser believes them. */
function VerifiedRoles() {
  const { userId, orgId } = useAuth();
  const apiFetch = useApiFetch();
  const me = useQuery({
    // Keyed by the verified user and org, so a switch never shows the previous role.
    queryKey: ["tenant", orgId && userId ? identityOf(userId, orgId) : "none", "me"],
    enabled: Boolean(userId && orgId),
    queryFn: async () => {
      const res = await apiFetch("/api/me");
      if (res.status === 401) return null;
      if (!res.ok) throw new Error(`/api/me returned ${res.status}`);
      return Me.parse(await res.json());
    },
  });

  if (!orgId) return <Badge tone="warn">Choose an organization</Badge>;
  if (me.isPending) return <span className="text-xs text-subtle">checking role…</span>;
  if (me.isError || me.data === null) return <Badge tone="danger">Role not verified</Badge>;
  if (me.data.roles.length === 0) return <Badge tone="neutral">Read only</Badge>;
  return (
    <span data-testid="verified-roles" className="flex flex-wrap gap-1">
      {me.data.roles.map((r) => (
        <Badge key={r} tone={r === "finance_lead" ? "info" : "neutral"} icon="users">
          {roleLabel[r]}
        </Badge>
      ))}
    </span>
  );
}
