import { useQuery } from "@tanstack/react-query";
import { humanize } from "../format";
import { loadReplay, loadReplayIndex, type SavedReplay } from "../replay";
import { AppShell, Segmented } from "./AppShell";
import { PlanReview } from "./PlanReview";
import { RunReport } from "./RunTimeline";
import { Alert, Card, Chip, Icon, Skeleton } from "./ui";

/** A saved run, read-only and public. Nothing on this page reads or changes live data. */
export function ReplayPage({ id }: { id: string }) {
  const index = useQuery({ queryKey: ["replay-index"], queryFn: () => loadReplayIndex() });
  const replay = useQuery({
    queryKey: ["replay", id],
    enabled: id !== "",
    queryFn: () => loadReplay(id),
  });

  return (
    <AppShell
      status={false}
      nav={
        index.data && (
          <Segmented
            label="Saved replays"
            value={id}
            options={index.data.map((r) => ({
              id: r.id,
              text: humanize(r.id),
              title: r.title,
              href: `?replay=${r.id}`,
            }))}
          />
        )
      }
    >
      {id === "" && !index.isPending && (
        <Card className="border-dashed bg-transparent px-6 py-14 text-center shadow-none">
          <p className="text-base font-semibold text-ink">Choose a saved replay</p>
          <p className="mt-1 text-sm text-muted">
            Each one is a recording of a plan and what happened when it was applied.
          </p>
        </Card>
      )}
      {replay.isPending && id !== "" && (
        <div aria-busy="true" className="space-y-5">
          <p className="sr-only">Loading replay…</p>
          <Skeleton className="h-24" />
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-72" />
        </div>
      )}
      {replay.isError && <Alert>This saved replay can't be shown: {replay.error.message}</Alert>}
      {replay.data && <ReplayView replay={replay.data} />}
    </AppShell>
  );
}

export function ReplayView({ replay }: { replay: SavedReplay }) {
  return (
    <div className="enter flex flex-col gap-6">
      <aside
        role="note"
        data-testid="replay-banner"
        className="flex flex-col gap-3 rounded-2xl border border-warn-line bg-warn-bg p-4 text-warn sm:flex-row sm:items-start sm:gap-4 sm:p-5"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface/70">
          <Icon name="film" className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-[15px] leading-6 font-semibold">
            Saved replay, not live
            {replay.evidence === "fixture" ? (
              <Chip tone="warn" icon="flask" hint="Not run against real Era images">
                Fixture
              </Chip>
            ) : (
              <Chip tone="good" icon="check">
                Ran on Era
              </Chip>
            )}
          </p>
          <p className="mt-1 text-sm leading-5">
            This is a recording of {replay.title.toLowerCase()}, saved{" "}
            {new Date(replay.savedAt).toUTCString()}. Nothing here can be changed or applied.
          </p>
          <p className="mt-1 text-[13px] leading-5">{replay.source}</p>
        </div>
      </aside>

      {/* What happened comes first; the plan that was applied follows. */}
      <RunReport run={replay.run} events={replay.events} manifest={replay.manifest} />
      <PlanReview
        manifest={replay.manifest}
        planHash={replay.planHash}
        evidence={replay.evidence}
      />
    </div>
  );
}
