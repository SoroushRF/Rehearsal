import { useAuth } from "@clerk/react";
import { useState } from "react";
import { AccountBar, clerkKey, useApiFetch } from "./auth";
import { AppShell, Segmented } from "./components/AppShell";
import { LiveApp } from "./components/LivePlans";
import { PlanReview } from "./components/PlanReview";
import { ReplayPage } from "./components/ReplayPage";
import { Alert, Card } from "./components/ui";
import { type FixtureBundle, fixtureBundles } from "./fixtures";
import { humanize } from "./format";
import { IdentityScope, identityOf } from "./identity";
import { Landing } from "./landing/Landing";
import { replayParam } from "./replay";
import { routeFor } from "./route";

/**
 * Review UI (T2). A signed-in reviewer with an organization reviews that org's stored plans
 * through the API; everyone else sees the shared fixture bundles, read-only.
 */
export function App({ bundles = fixtureBundles }: { bundles?: FixtureBundle[] }) {
  // The landing page and saved runs are public and static: no sign-in and no API.
  const route = routeFor(window.location.pathname, window.location.search);
  if (route === "landing") return <Landing />;
  if (route === "replay") return <ReplayPage id={replayParam(window.location.search) ?? ""} />;
  return (
    <AppShell account={<AccountBar />}>
      {clerkKey ? <SignedInOrFixtures bundles={bundles} /> : <FixturePlans bundles={bundles} />}
    </AppShell>
  );
}

function SignedInOrFixtures({ bundles }: { bundles: FixtureBundle[] }) {
  const { isSignedIn, userId, orgId } = useAuth();
  const apiFetch = useApiFetch();
  const identity = isSignedIn && userId && orgId ? identityOf(userId, orgId) : null;
  return (
    <IdentityScope
      identity={identity}
      fallback={
        <div className="flex flex-col gap-6">
          <Alert tone="info" title="Sign in to review live plans">
            Sign in and choose an organization to rehearse incidents and approve plans. Until then,
            these are example plans, read-only.
          </Alert>
          <FixturePlans bundles={bundles} />
        </div>
      }
    >
      <LiveApp apiFetch={apiFetch} />
    </IdentityScope>
  );
}

function FixturePlans({ bundles }: { bundles: FixtureBundle[] }) {
  const [bundleId, setBundleId] = useState(() => initialBundle(bundles));
  const current = bundles.find((b) => b.bundle.id === bundleId) ?? bundles[0];

  const choose = (id: string) => {
    setBundleId(id);
    const url = new URL(window.location.href);
    url.searchParams.set("bundle", id);
    window.history.replaceState(null, "", url);
  };

  if (!current) {
    return (
      <Card className="border-dashed bg-transparent px-6 py-14 text-center shadow-none">
        <p className="text-base font-semibold text-ink">No plans to review.</p>
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold tracking-wider text-subtle uppercase">Example plan</p>
          <p className="text-sm text-muted">{current.bundle.title}</p>
        </div>
        <Segmented
          label="Fixture plans"
          value={current.bundle.id}
          onChange={choose}
          options={bundles.map(({ bundle }) => ({
            id: bundle.id,
            text: humanize(bundle.id),
            title: bundle.title,
          }))}
        />
      </div>
      <PlanReview
        manifest={current.bundle.manifest}
        planHash={current.planHash}
        evidence={current.bundle.evidence}
      />
    </div>
  );
}

function initialBundle(bundles: FixtureBundle[]): string | undefined {
  const requested =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("bundle");
  return bundles.find((b) => b.bundle.id === requested)?.bundle.id ?? bundles[0]?.bundle.id;
}
