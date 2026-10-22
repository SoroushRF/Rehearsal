import type { PlanManifest, ReceiptOutcome, RunEvent, RunState } from "@rehearsal/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { type ApiFetch, call, explain, StoredPlan } from "../api";
import { shortHash } from "../format";
import {
  describeEvent,
  explainReceipt,
  FINISHED,
  latestReceipts,
  outcomeLabel,
  RunEvents,
  type RunView,
} from "../runs";
import { Badge, type Tone } from "./Badge";

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
  const applied = useQuery({
    queryKey: ["plan", run?.planId, run?.revision],
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
    return (
      <p className="mt-4 text-sm text-slate-500">
        {problem ? explain(problem) : `Loading run ${runId}…`}
      </p>
    );
  }
  return <RunReport run={run} events={events} manifest={applied.data.manifest} />;
}

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
    <section
      aria-label={`Run ${run.id}`}
      data-testid="run-report"
      className="mt-4 rounded-lg border border-slate-200 bg-white"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3">
        <h3 className="font-medium">Run</h3>
        <code className="font-mono text-xs text-slate-500">{run.id}</code>
        <Badge tone={stateTone[run.state]}>{run.state}</Badge>
        {running && <span className="text-xs text-slate-500">updating…</span>}
        <span className="ml-auto text-xs text-slate-500">
          revision {run.revision} · hash{" "}
          <code className="font-mono">{shortHash(run.planHash)}</code> · approval {run.approvalId}
        </span>
      </header>

      {receipts.size > 0 && (
        <p className="px-4 pt-3 text-sm text-slate-600">
          {[...counts].map(([o, n]) => `${n} ${outcomeLabel[o].toLowerCase()}`).join(" · ")}
        </p>
      )}

      <ol className="divide-y divide-slate-100">
        {manifest.actions.map((a) => {
          const r = receipts.get(a.id);
          return (
            <li
              key={a.id}
              data-testid="run-step"
              data-action-id={a.id}
              data-outcome={r?.outcome ?? "pending"}
              className={`flex gap-3 px-4 py-2.5 text-sm ${r?.outcome === "held" ? "bg-amber-50" : ""}`}
            >
              <code className="w-24 shrink-0 font-mono text-xs leading-5 text-slate-500">
                {a.id}
              </code>
              <div className="min-w-0 flex-1">
                {r ? (
                  <>
                    <Badge tone={outcomeTone[r.outcome]}>{outcomeLabel[r.outcome]}</Badge>{" "}
                    <span>{explainReceipt(r)}</span>
                    {r.limitations.length > 0 && (
                      <p className="mt-0.5 text-xs text-slate-500">
                        Limits: {r.limitations.join("; ")}
                      </p>
                    )}
                  </>
                ) : (
                  <span className="text-slate-400">
                    {running ? "not reached yet" : "no receipt"}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <details className="border-t border-slate-100 px-4 py-2 text-sm">
        <summary className="cursor-pointer text-slate-600">Event log ({events.length})</summary>
        <ol className="mt-2 space-y-1">
          {events.map((e) => (
            <li key={e.seq} className="flex gap-3">
              <span className="w-20 shrink-0 font-mono text-xs leading-5 text-slate-400">
                {new Date(e.at).toLocaleTimeString()}
              </span>
              <span>{describeEvent(e)}</span>
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}
