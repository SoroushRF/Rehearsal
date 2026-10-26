import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "../src/components/AppShell";
import { LiveApp } from "../src/components/LivePlans";
import { IdentityScope, identityOf } from "../src/identity";
import { appView } from "../src/route";
import "../src/index.css";

/**
 * Renders the live review flow with plain fetch; Playwright answers every /api call. The buttons
 * stand in for Clerk: they change the signed-in user or organization, or sign out, through the same
 * `IdentityScope` the real app uses. Each request names its identity in `x-test-identity`.
 */
/** The plans page unless the test opens another section with `?view=`. */
const view = new URLSearchParams(window.location.search).has("view")
  ? appView(window.location.search)
  : "plans";
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function Harness() {
  const [who, setWho] = useState<{ userId: string; orgId: string } | null>({
    userId: "user_a",
    orgId: "org_a",
  });
  const identity = who && identityOf(who.userId, who.orgId);
  const apiFetch = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (identity) headers.set("x-test-identity", identity);
    return fetch(path, { ...init, headers });
  };
  return (
    <AppShell
      account={
        <div className="flex flex-wrap gap-2 text-xs">
          <button type="button" onClick={() => setWho({ userId: "user_a", orgId: "org_a" })}>
            Be user A in org A
          </button>
          <button type="button" onClick={() => setWho({ userId: "user_a", orgId: "org_b" })}>
            Switch to org B
          </button>
          <button type="button" onClick={() => setWho({ userId: "user_c", orgId: "org_b" })}>
            Sign in as user C in org B
          </button>
          <button type="button" onClick={() => setWho(null)}>
            Sign out
          </button>
        </div>
      }
    >
      <IdentityScope identity={identity} fallback={<p data-testid="signed-out">Signed out</p>}>
        <LiveApp apiFetch={apiFetch} initialView={view} />
      </IdentityScope>
    </AppShell>
  );
}

// biome-ignore lint/style/noNonNullAssertion: root element is in live.html
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <Harness />
  </QueryClientProvider>,
);
