import { useQuery } from "@tanstack/react-query";
import { loadReplay, loadReplayIndex, type SavedReplay } from "../replay";
import { Badge } from "./Badge";
import { PlanReview } from "./PlanReview";
import { RunReport } from "./RunTimeline";

/** A saved run, read-only and public. Nothing on this page reads or changes live data. */
export function ReplayPage({ id }: { id: string }) {
  const index = useQuery({ queryKey: ["replay-index"], queryFn: () => loadReplayIndex() });
  const replay = useQuery({
    queryKey: ["replay", id],
    enabled: id !== "",
    queryFn: () => loadReplay(id),
  });

  return (
    <main className="mx-auto max-w-4xl p-6 font-sans text-slate-900">
      <h1 className="text-2xl font-semibold">Rehearsal</h1>
      <p className="mt-1 text-slate-600">
        Rehearse the plan. Approve its effects. Apply with evidence.
      </p>

      <nav aria-label="Saved replays" className="mt-6 flex flex-wrap gap-2">
        {index.data?.map((r) => (
          <a
            key={r.id}
            href={`?replay=${r.id}`}
            title={r.title}
            aria-current={r.id === id ? "page" : undefined}
            className="rounded-full border border-slate-300 px-3 py-1 text-sm aria-[current=page]:border-slate-900 aria-[current=page]:bg-slate-900 aria-[current=page]:text-white"
          >
            {r.id}
          </a>
        ))}
      </nav>

      {id === "" && !index.isPending && (
        <p className="mt-4 text-slate-600">Choose a saved replay.</p>
      )}
      {replay.isPending && id !== "" && (
        <p className="mt-4 text-sm text-slate-500">Loading replay…</p>
      )}
      {replay.isError && (
        <p role="alert" className="mt-4 rounded bg-rose-50 p-2 text-sm text-rose-800">
          This saved replay can't be shown: {replay.error.message}
        </p>
      )}
      {replay.data && <ReplayView replay={replay.data} />}
    </main>
  );
}

export function ReplayView({ replay }: { replay: SavedReplay }) {
  return (
    <div className="mt-4">
      <aside
        role="note"
        data-testid="replay-banner"
        className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
      >
        <p className="flex flex-wrap items-center gap-2 font-semibold">
          Saved replay, not live
          {replay.evidence === "fixture" ? (
            <Badge tone="warn" hint="Not run against real Era images">
              Fixture
            </Badge>
          ) : (
            <Badge tone="good">Ran on Era</Badge>
          )}
        </p>
        <p className="mt-1">
          This is a recording of {replay.title.toLowerCase()}, saved{" "}
          {new Date(replay.savedAt).toUTCString()}. Nothing here can be changed or applied.
        </p>
        <p className="mt-1 text-amber-900">{replay.source}</p>
      </aside>

      <div className="mt-4">
        <PlanReview
          manifest={replay.manifest}
          planHash={replay.planHash}
          evidence={replay.evidence}
        />
      </div>
      <RunReport run={replay.run} events={replay.events} manifest={replay.manifest} />
    </div>
  );
}
