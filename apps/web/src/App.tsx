import { HealthResponse } from "@rehearsal/contracts";
import { useQuery } from "@tanstack/react-query";

/** Review UI shell (owner: C). Build screens against fixture plans before the executor exists. */
export function App() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: async () => HealthResponse.parse(await (await fetch("/api/health")).json()),
  });

  return (
    <main className="mx-auto max-w-3xl p-6 font-sans text-slate-900">
      <h1 className="text-2xl font-semibold">Rehearsal</h1>
      <p className="mt-1 text-slate-600">
        Rehearse the plan. Approve its effects. Apply with evidence.
      </p>
      <p className="mt-6 text-sm">
        API:{" "}
        {health.isPending
          ? "checking…"
          : health.isError
            ? "unreachable"
            : `ok (${health.data.mode} mode, contracts v${health.data.contractsVersion})`}
      </p>
    </main>
  );
}
