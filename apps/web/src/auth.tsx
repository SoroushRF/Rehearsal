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
import { roleLabel } from "./format";
import { identityOf } from "./identity";

/** Without a publishable key the app runs read-only on fixtures: no sign-in, no commands. */
export const clerkKey: string | undefined = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY || undefined;

export function AuthProvider({ children }: { children: ReactNode }) {
  return clerkKey ? <ClerkProvider publishableKey={clerkKey}>{children}</ClerkProvider> : children;
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
      <p className="text-xs text-slate-500">
        Sign-in isn't configured here, so plans are read-only fixtures.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Show when="signed-out">
        <SignInButton mode="modal">
          <button
            type="button"
            className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
          >
            Sign in
          </button>
        </SignInButton>
      </Show>
      <Show when="signed-in">
        <OrganizationSwitcher hidePersonal />
        <VerifiedRoles />
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
  if (me.isPending) return <span className="text-xs text-slate-500">checking role…</span>;
  if (me.isError || me.data === null) return <Badge tone="danger">Role not verified</Badge>;
  if (me.data.roles.length === 0) return <Badge tone="neutral">Read only</Badge>;
  return (
    <span data-testid="verified-roles" className="flex gap-1">
      {me.data.roles.map((r) => (
        <Badge key={r} tone={r === "finance_lead" ? "info" : "neutral"}>
          {roleLabel[r]}
        </Badge>
      ))}
    </span>
  );
}
