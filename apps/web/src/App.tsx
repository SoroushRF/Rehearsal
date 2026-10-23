import { useAuth } from "@clerk/react";
import { HealthResponse } from "@rehearsal/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AccountBar, clerkKey, useApiFetch } from "./auth";
import { LivePlans } from "./components/LivePlans";
import { PlanReview } from "./components/PlanReview";
import { ReplayPage } from "./components/ReplayPage";
import { type FixtureBundle, fixtureBundles } from "./fixtures";
import { replayParam } from "./replay";

/**
 * Review UI (T2). A signed-in reviewer with an organization reviews that org's stored plans
 * through the API; everyone else sees the shared fixture bundles, read-only.
 */
export function App({ bundles = fixtureBundles }: { bundles?: FixtureBundle[] }) {
  // `?replay=<id>` opens a saved run: public, read-only, no sign-in and no API.
  const replay = replayParam(window.location.search);
  if (replay !== null) return <ReplayPage id={replay} />;
  return (
    <main className="mx-auto max-w-4xl p-6 font-sans text-slate-900">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Rehearsal</h1>
          <p className="mt-1 text-slate-600">
            Rehearse the plan. Approve its effects. Apply with evidence.
          </p>
        </div>
        <AccountBar />
      </header>

      {clerkKey ? <SignedInOrFixtures bundles={bundles} /> : <FixturePlans bundles={bundles} />}

      <ApiStatus />
    </main>
  );
}

function SignedInOrFixtures({ bundles }: { bundles: FixtureBundle[] }) {
  const { isSignedIn, orgId } = useAuth();
  const apiFetch = useApiFetch();
  if (isSignedIn && orgId) return <LivePlans apiFetch={apiFetch} />;
  return (
    <>
      <p className="mt-6 text-sm text-slate-600">
        Sign in and choose an organization to review live plans. Until then, these are the shared
        fixtures.
      </p>
      <FixturePlans bundles={bundles} />
    </>
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

  return (
    <>
      <nav aria-label="Fixture plans" className="mt-6 flex flex-wrap gap-2">
        {bundles.map(({ bundle }) => (
          <button
            key={bundle.id}
            type="button"
            title={bundle.title}
            aria-current={bundle.id === current?.bundle.id ? "page" : undefined}
            onClick={() => choose(bundle.id)}
            className="rounded-full border border-slate-300 px-3 py-1 text-sm aria-[current=page]:border-slate-900 aria-[current=page]:bg-slate-900 aria-[current=page]:text-white"
          >
            {bundle.id}
          </button>
        ))}
      </nav>

      {current ? (
        <div className="mt-4">
          <p className="mb-3 text-sm text-slate-600">{current.bundle.title}</p>
          <PlanReview
            manifest={current.bundle.manifest}
            planHash={current.planHash}
            evidence={current.bundle.evidence}
          />
        </div>
      ) : (
        <p className="mt-6 text-slate-600">No plans to review.</p>
      )}
    </>
  );
}

function initialBundle(bundles: FixtureBundle[]): string | undefined {
  const requested =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("bundle");
  return bundles.find((b) => b.bundle.id === requested)?.bundle.id ?? bundles[0]?.bundle.id;
}

function ApiStatus() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: async () => HealthResponse.parse(await (await fetch("/api/health")).json()),
  });
  return (
    <p className="mt-8 text-xs text-slate-500">
      API:{" "}
      {health.isPending
        ? "checking…"
        : health.isError
          ? "unreachable"
          : `ok (${health.data.mode} mode, contracts v${health.data.contractsVersion})`}
    </p>
  );
}
