import type { PlanManifest, ReceiptOutcome, RunEvent, RunState } from "@rehearsal/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { type ApiFetch, call, explain, StoredPlan } from "../api";
import { shortHash } from "../format";
import { useTenantKey } from "../identity";
import {
  describeEvent,
  explainReceipt,
  FINISHED,
  latestReceipts,
  outcomeLabel,
  RunEvents,
  type RunView,
} from "../runs";
import { Alert, Card, Chip, Icon, type IconName, Skeleton, Spinner, type Tone } from "./ui";

const POLL_MS = 1000;

const outcomeTone: Record<ReceiptOutcome, Tone> = {
  confirmed: "good",
  compensated: "good",
  compensation_conflict: "info",
  held: "warn",
  skipped_dependency: "neutral",
  unknown_outcome: "warn",
  rejected: "danger",
};

const stateTone: Record<RunState, Tone> = {
  planning: "neutral",
  review_ready: "neutral",
  approved: "info",
  applying: "info",
  completed: "good",
  partial: "warn",
  held: "warn",
  failed: "danger",
  cancelled: "neutral",
};

/** Polls a run's events (from the last seen `seq`) until the run finishes. */
export function useRunEvents(apiFetch: ApiFetch, runId: string) {
  const [run, setRun] = useState<RunView | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let stopped = false;
    let after = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const page = await call(apiFetch, RunEvents, `/api/runs/${runId}/events?after=${after}`);
        if (stopped) return;
        after = page.events.at(-1)?.seq ?? after;
        setRun(page.run);
        if (page.events.length > 0) setEvents((prev) => [...prev, ...page.events]);
        setError(null);
        if (page.more) timer = setTimeout(poll, 0);
        else if (!FINISHED.includes(page.run.state)) timer = setTimeout(poll, POLL_MS);
      } catch (err) {
        if (stopped) return;
        setError(err);
        timer = setTimeout(poll, POLL_MS * 3);
      }
    };
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [apiFetch, runId]);

  return { run, events, error };
}

/** A run against the exact revision it applied, which may be older than the plan's latest. */
export function RunTimeline({ apiFetch, runId }: { apiFetch: ApiFetch; runId: string }) {
  const { run, events, error } = useRunEvents(apiFetch, runId);
  const key = useTenantKey();
  const applied = useQuery({
    queryKey: key("plan", run?.planId, run?.revision),
    enabled: run !== null,
    queryFn: () =>
      call(
        apiFetch,
        StoredPlan,
        `/api/plans/${encodeURIComponent(run?.planId ?? "")}?revision=${run?.revision}`,
      ),
  });
  const problem = error ?? applied.error;
  if (!run || !applied.data) {
    return problem ? (
      <Alert className="mt-2">{explain(problem)}</Alert>
    ) : (
      <div aria-busy="true" className="space-y-3">
        <p className="sr-only">Loading run {runId}…</p>
        <Skeleton className="h-48" />
      </div>
    );
  }
  return <RunReport run={run} events={events} manifest={applied.data.manifest} />;
}

const STEP: Record<ReceiptOutcome, { icon: IconName; ring: string }> = {
  confirmed: { icon: "check", ring: "bg-ok-bg text-ok ring-ok-line" },
  compensated: { icon: "undo", ring: "bg-ok-bg text-ok ring-ok-line" },
  compensation_conflict: { icon: "shield", ring: "bg-info-bg text-info ring-info-line" },
  held: { icon: "alert", ring: "bg-warn-bg text-warn ring-warn-line" },
  skipped_dependency: { icon: "arrow", ring: "bg-sunken text-subtle ring-line" },
  unknown_outcome: { icon: "clock", ring: "bg-warn-bg text-warn ring-warn-line" },
  rejected: { icon: "x", ring: "bg-danger-bg text-danger ring-danger-line" },
};

/** Segment colors for the progress bar: one slice per step, by what happened to it. */
const SEGMENT: Record<ReceiptOutcome | "pending", string> = {
  confirmed: "bg-ok-solid",
  compensated: "bg-ok-solid",
  compensation_conflict: "bg-info-solid",
  held: "bg-warn-solid",
  skipped_dependency: "bg-line-strong",
  unknown_outcome: "bg-warn-solid",
  rejected: "bg-danger-solid",
  pending: "bg-line",
};

/** A finished or running apply, step by step, for someone who wasn't watching. */
export function RunReport({
  run,
  events,
  manifest,
}: {
  run: RunView;
  events: readonly RunEvent[];
  manifest: PlanManifest;
}) {
  const receipts = latestReceipts(events);
  const counts = new Map<ReceiptOutcome, number>();
  for (const r of receipts.values()) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
  const running = !FINISHED.includes(run.state);

  return (
    <Card aria-label={`Run ${run.id}`} data-testid="run-report" className="overflow-hidden">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-4 sm:px-5 sm:pt-5">
        <h3 className="text-base font-semibold text-ink">Run</h3>
        <Chip tone={stateTone[run.state]}>{run.state}</Chip>
        {running && (
          <span className="inline-flex items-center gap-1.5 text-xs text-subtle">
            <Spinner className="h-3.5 w-3.5" />
            updating…
          </span>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-x-3 text-xs text-subtle">
          <code className="font-mono">{run.id}</code>
          <span>
            revision {run.revision} · hash{" "}
            <code className="font-mono">{shortHash(run.planHash)}</code> · approval {run.approvalId}
          </span>
        </span>
      </header>

      <div className="px-4 pt-4 sm:px-5">
        <div
          className="flex h-2 gap-0.5 overflow-hidden rounded-full"
          role="img"
          aria-label="Outcome of each step"
        >
          {manifest.actions.map((a) => (
            <span
              key={a.id}
              className={`h-full flex-1 ${SEGMENT[receipts.get(a.id)?.outcome ?? "pending"]}`}
            />
          ))}
        </div>
        {receipts.size > 0 && (
          <p className="mt-2 text-sm text-muted">
            {[...counts].map(([o, n]) => `${n} ${outcomeLabel[o].toLowerCase()}`).join(" · ")}
          </p>
        )}
      </div>

      <ol className="mt-3 divide-y divide-line border-t border-line">
        {manifest.actions.map((a) => {
          const r = receipts.get(a.id);
          const step = r ? STEP[r.outcome] : null;
          return (
            <li
              key={a.id}
              data-testid="run-step"
              data-action-id={a.id}
              data-outcome={r?.outcome ?? "pending"}
              className={`flex gap-3 px-4 py-3.5 sm:gap-4 sm:px-5 ${r?.outcome === "held" ? "bg-warn-bg/60" : ""}`}
            >
              <span
                className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-1 ring-inset ${
                  step ? step.ring : "bg-surface text-subtle ring-line-strong"
                }`}
              >
                {step ? (
                  <Icon name={step.icon} className="h-4 w-4" />
                ) : running ? (
                  <Spinner className="h-3.5 w-3.5" />
                ) : (
                  <span className="h-1.5 w-1.5 rounded-full bg-subtle/50" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <code className="font-mono text-[13px] font-medium text-ink">{a.id}</code>
                  {r ? (
                    <Chip tone={outcomeTone[r.outcome]}>{outcomeLabel[r.outcome]}</Chip>
                  ) : (
                    <span className="text-xs text-subtle">
                      {running ? "not reached yet" : "no receipt"}
                    </span>
                  )}
                </div>
                {r && <p className="mt-1 text-sm leading-5 text-muted">{explainReceipt(r)}</p>}
                {r && r.limitations.length > 0 && (
                  <p className="mt-1 text-xs text-subtle">Limits: {r.limitations.join("; ")}</p>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <details className="group border-t border-line px-4 py-3 text-sm sm:px-5">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 font-medium text-muted hover:text-ink">
          <Icon name="chevron" className="h-4 w-4 transition-transform group-open:rotate-90" />
          Event log ({events.length})
        </summary>
        <ol className="mt-3 space-y-1.5">
          {events.map((e) => (
            <li key={e.seq} className="flex gap-3">
              <span className="tnum w-[4.5rem] shrink-0 font-mono text-xs leading-5 text-subtle">
                {new Date(e.at).toLocaleTimeString()}
              </span>
              <span className="text-muted">{describeEvent(e)}</span>
            </li>
          ))}
        </ol>
      </details>
    </Card>
  );
}
