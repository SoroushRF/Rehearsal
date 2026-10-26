import type { PlanManifest, RehearsalScenarioId } from "@rehearsal/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type ApiFetch, call, explain } from "../api";
import {
  activeFor,
  type CurrentPlan,
  cancelRehearsalPath,
  ExecutionRehearsalCancelled,
  ExecutionRehearsalList,
  ExecutionRehearsalStarted,
  type ExecutionRehearsalSummary,
  executionRehearsalsPath,
  explainRehearsalRefusal,
  isTerminal,
  isUnavailable,
  newestFirst,
  relationTo,
  requestFor,
  SCENARIOS,
  STAGES,
  scenarioInfo,
  stateCopy,
} from "../execution-rehearsal";
import { shortHash } from "../format";
import { useTenantKey } from "../identity";
import { RehearsalReportToggle } from "./RehearsalReport";
import { Alert, Button, Chip } from "./ui";

const POLL_MS = 2000;

const explainAny = (err: unknown) => explainRehearsalRefusal(err) ?? explain(err);

/**
 * Try the plan on screen in a disposable copy of the company under a chosen challenge, and follow
 * it until it finishes. Starting one never approves or applies anything: it runs in separate
 * worlds and the plan still needs its ordinary approval.
 */
export function ExecutionRehearsalPanel({
  apiFetch,
  plan,
  editing,
  manifest,
}: {
  apiFetch: ApiFetch;
  plan: CurrentPlan;
  /** Boxes are unchecked and no revision exists for them yet: there is nothing exact to rehearse. */
  editing: boolean;
  /** The plan on screen, to name the steps in a report that ran on exactly it. */
  manifest: PlanManifest | null;
}) {
  const queryClient = useQueryClient();
  const key = useTenantKey();
  const listKey = key("execution-rehearsals", plan.planId);
  const [scenario, setScenario] = useState<RehearsalScenarioId>("clean");
  const [note, setNote] = useState<string | null>(null);

  const list = useQuery({
    queryKey: listKey,
    queryFn: () =>
      call(apiFetch, ExecutionRehearsalList, executionRehearsalsPath(plan.planId)).then(
        (l) => l.rehearsals,
      ),
    // Follow progress while anything is still going; a finished list is left alone.
    refetchInterval: (q) => (q.state.data?.some((r) => !isTerminal(r.state)) ? POLL_MS : false),
    retry: false,
  });

  const start = useMutation({
    mutationFn: (id: RehearsalScenarioId) =>
      call(
        apiFetch,
        ExecutionRehearsalStarted,
        executionRehearsalsPath(plan.planId),
        requestFor(plan, id),
      ),
    onMutate: () => setNote(null),
    onSuccess: (res) => {
      if (res.existing) {
        setNote(
          isTerminal(res.rehearsal.state)
            ? "This exact rehearsal already finished; its result is below."
            : "This exact rehearsal is already in progress; showing that one.",
        );
      }
      queryClient.invalidateQueries({ queryKey: listKey });
    },
  });

  const cancel = useMutation({
    mutationFn: (rehearsalId: string) =>
      call(apiFetch, ExecutionRehearsalCancelled, cancelRehearsalPath(rehearsalId), {}),
    onMutate: () => setNote(null),
    // Already ended is not an error worth showing: the list says how it ended.
    onSettled: () => queryClient.invalidateQueries({ queryKey: listKey }),
  });

  if (list.isPending) {
    return (
      <Panel>
        <p className="text-sm text-subtle">Loading rehearsals…</p>
      </Panel>
    );
  }
  if (list.isError && isUnavailable(list.error)) {
    return (
      <Panel>
        <p data-testid="exec-rehearsal-unavailable" className="text-sm text-muted">
          Rehearsing this plan in a disposable copy isn't available on this server yet. You can
          still review and approve the plan.
        </p>
      </Panel>
    );
  }
  if (list.isError) {
    return (
      <Panel>
        <Alert>{explainAny(list.error)}</Alert>
      </Panel>
    );
  }

  const rehearsals = newestFirst(list.data);
  const running = activeFor(rehearsals, plan, scenario);
  const blocked = editing
    ? "Create the revision first; a rehearsal runs the exact stored plan."
    : running
      ? `${scenarioInfo(scenario).title} is already ${stateCopy[running.state].label.toLowerCase()} for revision ${plan.revision}.`
      : null;

  return (
    <Panel>
      <fieldset className="mt-4">
        <legend className="text-xs font-semibold tracking-wide text-subtle uppercase">
          Challenge
        </legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {SCENARIOS.map((s) => (
            <label
              key={s.id}
              className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-surface p-3 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
            >
              <input
                type="radio"
                name="exec-scenario"
                value={s.id}
                checked={scenario === s.id}
                onChange={() => setScenario(s.id)}
                className="mt-1"
              />
              <span>
                <span className="block font-medium text-ink">{s.title}</span>
                <span className="block text-xs leading-5 text-muted">{s.what}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          icon="flask"
          loading={start.isPending}
          disabled={blocked !== null}
          onClick={() => start.mutate(scenario)}
        >
          Rehearse revision {plan.revision}
        </Button>
        <span className="text-xs text-subtle">
          Runs <code className="font-mono">{shortHash(plan.planHash)}</code> in disposable worlds.
        </span>
      </div>
      {blocked && (
        <p data-testid="exec-rehearsal-blocked" className="mt-2 text-xs text-muted">
          {blocked}
        </p>
      )}
      {start.isError && (
        <Alert className="mt-3" data-testid="exec-rehearsal-error">
          {explainAny(start.error)}
        </Alert>
      )}
      {note && (
        <Alert tone="info" className="mt-3" data-testid="exec-rehearsal-note">
          {note}
        </Alert>
      )}

      {rehearsals.length > 0 && (
        <ul aria-label="Rehearsals" className="mt-5 flex flex-col gap-3">
          {rehearsals.map((r) => (
            <RehearsalRow
              key={r.rehearsalId}
              r={r}
              current={plan}
              onRetry={() => start.mutate(r.scenario.id)}
              retrying={start.isPending}
              onCancel={() => cancel.mutate(r.rehearsalId)}
              cancelling={cancel.isPending && cancel.variables === r.rehearsalId}
              report={
                isTerminal(r.state) ? (
                  <RehearsalReportToggle
                    apiFetch={apiFetch}
                    rehearsalId={r.rehearsalId}
                    current={plan}
                    manifest={manifest}
                  />
                ) : null
              }
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <section aria-label="Execution rehearsal" className="border-y border-line py-4">
      <div className="flex items-start gap-3">
        <div>
          <h2 className="text-[15px] leading-6 font-semibold text-ink">
            Rehearse this plan before approving
          </h2>
          <p className="text-sm leading-5 text-muted">
            Runs the exact stored plan in a disposable copy of the company, under a challenge you
            pick. It approves nothing and changes nothing real; the plan still needs its own
            approval.
          </p>
        </div>
      </div>
      {children}
    </section>
  );
}

const TONE = {
  completed: "good",
  failed: "danger",
  cancelled: "warn",
} as const;

function RehearsalRow({
  r,
  current,
  onRetry,
  retrying,
  onCancel,
  cancelling,
  report,
}: {
  r: ExecutionRehearsalSummary;
  current: CurrentPlan;
  onRetry: () => void;
  retrying: boolean;
  onCancel: () => void;
  cancelling: boolean;
  report?: React.ReactNode;
}) {
  const relation = relationTo(r, current);
  const copy = stateCopy[r.state];
  const tone = r.state in TONE ? TONE[r.state as keyof typeof TONE] : "info";
  const retryable = r.state === "failed" || r.state === "cancelled";
  return (
    <li
      data-testid="exec-rehearsal"
      data-state={r.state}
      data-relation={relation}
      className="rounded-xl border border-line bg-sunken/40 p-3.5"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium text-ink">{scenarioInfo(r.scenario.id).title}</span>
        <Chip
          tone={tone}
          icon={r.state === "completed" ? "check" : r.state === "failed" ? "x" : "clock"}
        >
          {copy.label}
        </Chip>
        <span className="text-xs text-subtle">
          revision {r.plan.revision} ·{" "}
          <code className="font-mono">{shortHash(r.plan.planHash)}</code>
        </span>
        {relation !== "current" && (
          <Chip
            tone="warn"
            hint="The plan on screen is a different version from the one this ran on."
          >
            Not the revision you're reviewing
          </Chip>
        )}
      </div>

      {!isTerminal(r.state) && <Stages state={r.state} />}
      {!isTerminal(r.state) && (
        <Button
          size="sm"
          variant="ghost"
          icon="x"
          className="mt-2"
          loading={cancelling}
          onClick={onCancel}
          data-testid="exec-rehearsal-cancel"
        >
          Cancel rehearsal
        </Button>
      )}
      <p data-testid="exec-rehearsal-say" className="mt-2 text-sm text-ink">
        {copy.say}
        {r.detail && (r.state === "failed" || r.state === "cancelled") ? ` ${r.detail}` : ""}
      </p>
      {relation !== "current" && (
        <p className="mt-1 text-xs text-muted">
          This stays tied to revision {r.plan.revision}. Revision {current.revision} needs its own
          rehearsal.
        </p>
      )}

      {(retryable || relation !== "current") && isTerminal(r.state) && (
        <Button size="sm" icon="play" className="mt-2" loading={retrying} onClick={onRetry}>
          {retryable ? "Try again" : "Rehearse"} on revision {current.revision}
        </Button>
      )}
      {report}
    </li>
  );
}

function Stages({ state }: { state: ExecutionRehearsalSummary["state"] }) {
  const at = STAGES.indexOf(state as (typeof STAGES)[number]);
  return (
    <ol className="mt-2 flex flex-wrap items-center gap-1.5" aria-label="Rehearsal progress">
      {STAGES.map((s, i) => (
        <li
          key={s}
          aria-current={i === at ? "step" : undefined}
          className={`rounded-full px-2 py-0.5 text-xs ${
            i < at
              ? "bg-ok-bg text-ok"
              : i === at
                ? "bg-accent text-on-accent"
                : "bg-sunken text-subtle"
          }`}
        >
          {stateCopy[s].label}
        </li>
      ))}
    </ol>
  );
}
