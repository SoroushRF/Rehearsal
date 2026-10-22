import { HealthResponse } from "@rehearsal/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PlanReview } from "./components/PlanReview";
import { type FixtureBundle, fixtureBundles } from "./fixtures";

/** Review UI (T2). Renders the shared fixture plans until real plans come from the API (T2.2). */
export function App({ bundles = fixtureBundles }: { bundles?: FixtureBundle[] }) {
  const [bundleId, setBundleId] = useState(() => initialBundle(bundles));
  const current = bundles.find((b) => b.bundle.id === bundleId) ?? bundles[0];

  const choose = (id: string) => {
    setBundleId(id);
    const url = new URL(window.location.href);
    url.searchParams.set("bundle", id);
    window.history.replaceState(null, "", url);
  };

  return (
    <main className="mx-auto max-w-4xl p-6 font-sans text-slate-900">
      <h1 className="text-2xl font-semibold">Rehearsal</h1>
      <p className="mt-1 text-slate-600">
        Rehearse the plan. Approve its effects. Apply with evidence.
      </p>

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

      <ApiStatus />
    </main>
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
