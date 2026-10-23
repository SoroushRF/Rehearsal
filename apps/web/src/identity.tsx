import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useEffect } from "react";

/**
 * Whose data is on screen. The browser cache and local state must never outlive the verified user
 * and organization they were loaded for, even though the API refuses anyone else's data.
 */
export const identityOf = (userId: string, orgId: string) => `${userId}/${orgId}`;

const IdentityContext = createContext<string | null>(null);

export function IdentityProvider({
  identity,
  children,
}: {
  identity: string;
  children: ReactNode;
}) {
  return <IdentityContext.Provider value={identity}>{children}</IdentityContext.Provider>;
}

/**
 * Builds a query key scoped to the active identity, so two identities can never share a cache
 * entry. Every query that holds tenant data must be keyed through this.
 */
export function useTenantKey() {
  const identity = useContext(IdentityContext);
  if (identity === null) throw new Error("tenant data needs an IdentityProvider");
  return useCallback(
    (...parts: readonly unknown[]) => ["tenant", identity, ...parts] as const,
    [identity],
  );
}

/**
 * Cancels and removes cached tenant data for every identity but `current` (null: nobody is signed
 * in). Called when the user or organization changes, and on sign-out.
 */
export function dropOtherTenants(queryClient: QueryClient, current: string | null) {
  const stale = {
    predicate: (q: { queryKey: readonly unknown[] }) =>
      q.queryKey[0] === "tenant" && q.queryKey[1] !== current,
  };
  queryClient.cancelQueries(stale);
  queryClient.removeQueries(stale);
}

/**
 * Shows tenant UI only for the verified identity it was given, and nothing from any other. A new
 * user or organization remounts `children`, so the selected plan, unchecked actions, mutations
 * and shown run all reset; the previous identity's cache is cancelled and removed. With no
 * identity (signed out) it drops every tenant cache and renders `fallback`.
 */
export function IdentityScope({
  identity,
  fallback,
  children,
}: {
  identity: string | null;
  fallback: ReactNode;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  useEffect(() => dropOtherTenants(queryClient, identity), [queryClient, identity]);
  if (identity === null) return fallback;
  return (
    <IdentityProvider key={identity} identity={identity}>
      {children}
    </IdentityProvider>
  );
}
