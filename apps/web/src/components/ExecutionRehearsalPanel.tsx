import type { PlanManifest, RehearsalScenarioId } from "@rehearsal/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { type ApiFetch, call, explain } from "../api";
import {
  CHALLENGES,
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
  SIMULATION,
  STAGES,
  scenarioInfo,
  startBlocked,
  stateCopy,
} from "../execution-rehearsal";
import { shortHash } from "../format";
import { useTenantKey } from "../identity";
import { RehearsalReportToggle } from "./RehearsalReport";
import { SimulationResult } from "./SimulationResult";
import { Alert, Button, Chip } from "./ui";

const POLL_MS = 2000;

const explainAny = (err: unknown) => explainRehearsalRefusal(err) ?? explain(err);

/**
 * Simulate the plan on screen: run it the way Apply would, in a disposable replica of the company,
 * and show what it did the way a run is shown. The failure tests (a challenge injected into the
 * replica) sit behind "Advanced". Starting either never approves or applies anything: it runs in
 * separate worlds and the plan still needs its ordinary approval.
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
  const [challenge, setChallenge] = useState<RehearsalScenarioId>(
    CHALLENGES[0]?.id ?? "phantom_membership",
  );
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

  // Set on the click itself, so a second click before the next render can't start a second job.
  const starting = useRef(false);
  const begin = (id: RehearsalScenarioId) => {
    if (starting.current) return;
    starting.current = true;
    start.mutate(id);
  };
  const start = useMutation({
    mutationFn: (id: RehearsalScenarioId) =>
      call(
        apiFetch,
        ExecutionRehearsalStarted,
        executionRehearsalsPath(plan.planId),
        requestFor(plan, id),
      ),
    onMutate: () => setNote(null),
    onSettled: () => {
      starting.current = false;
    },
    onSuccess: (res) => {
      if (res.existing) {
        setNote(
          isTerminal(res.rehearsal.state)
            ? "This exact rehearsal already finished; its result is below."
            : "This exact rehearsal is already in progress; showing that one.",
        );
      }
      // Stay busy until the list shows the new job, which then blocks a second start.
      return queryClient.invalidateQueries({ queryKey: listKey });
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
  const blockedFor = (id: RehearsalScenarioId) => startBlocked(rehearsals, plan, id, editing);
  const simulationBlocked = blockedFor(SIMULATION);
  const challengeBlocked = blockedFor(challenge);

  return (
    <Panel>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          icon="play"
          loading={start.isPending}
          disabled={simulationBlocked !== null}
          onClick={() => begin(SIMULATION)}
        >
          Simulate this plan
        </Button>
        <span className="text-xs text-subtle">
          Revision {plan.revision} · <code className="font-mono">{shortHash(plan.planHash)}</code>{" "}
          in a replica of the company.
        </span>
      </div>
      {simulationBlocked && (
        <p data-testid="exec-rehearsal-blocked" className="mt-2 text-xs text-muted">
          {simulationBlocked}
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
              onRetry={() => begin(r.scenario.id)}
              retryBlocked={blockedFor(r.scenario.id)}
              retrying={start.isPending}
              onCancel={() => cancel.mutate(r.rehearsalId)}
              cancelling={cancel.isPending && cancel.variables === r.rehearsalId}
              report={
                !isTerminal(r.state) ? null : r.scenario.id === SIMULATION &&
                  r.state === "completed" &&
                  relationTo(r, plan) === "current" ? (
                  <SimulationResult
                    apiFetch={apiFetch}
                    rehearsalId={r.rehearsalId}
                    current={plan}
                    manifest={manifest}
                  />
                ) : (
                  <RehearsalReportToggle
                    apiFetch={apiFetch}
                    rehearsalId={r.rehearsalId}
                    current={plan}
                    manifest={manifest}
                  />
                )
              }
            />
          ))}
        </ul>
      )}

      <details data-testid="exec-advanced" className="group mt-5 rounded-lg border border-line">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-muted hover:text-ink">
          Advanced: test against failures
        </summary>
        <div className="border-t border-line px-3 pb-3">
          <p className="mt-2 text-xs leading-5 text-muted">
            Each test breaks one thing on purpose in its own replica, to show the checks before
            every step hold. You don't need one to approve.
          </p>
          <fieldset className="mt-3">
            <legend className="text-xs font-semibold tracking-wide text-subtle uppercase">
              Challenge
            </legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {CHALLENGES.map((s) => (
                <label
                  key={s.id}
                  className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-surface p-3 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
                >
                  <input
                    type="radio"
                    name="exec-scenario"
                    value={s.id}
                    checked={challenge === s.id}
                    onChange={() => setChallenge(s.id)}
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
          <Button
            className="mt-3"
            icon="flask"
            loading={start.isPending}
            disabled={challengeBlocked !== null}
            onClick={() => begin(challenge)}
          >
            Run this test
          </Button>
          {challengeBlocked && (
            <p data-testid="exec-challenge-blocked" className="mt-2 text-xs text-muted">
              {challengeBlocked}
            </p>
          )}
        </div>
      </details>
    </Panel>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <section aria-label="Execution rehearsal" className="border-y border-line py-4">
      <div className="flex items-start gap-3">
        <div>
          <h2 className="text-[15px] leading-6 font-semibold text-ink">
            Simulate before approving
          </h2>
          <p className="text-sm leading-5 text-muted">
            Runs this exact plan the way Apply would, in a replica of the company. Nothing real
            changes, and the plan still needs its own approval.
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
  retryBlocked,
  retrying,
  onCancel,
  cancelling,
  report,
}: {
  r: ExecutionRehearsalSummary;
  current: CurrentPlan;
  onRetry: () => void;
  /** Why starting this row's scenario again is refused right now, as for the main button. */
  retryBlocked: string | null;
  retrying: boolean;
  onCancel: () => void;
  cancelling: boolean;
  report?: React.ReactNode;
}) {
  const relation = relationTo(r, current);
  const copy = stateCopy[r.state];
  const tone = r.state in TONE ? TONE[r.state as keyof typeof TONE] : "info";
  const retryable = r.state === "failed" || r.state === "cancelled";
  const simulation = r.scenario.id === SIMULATION;
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
          {simulation ? "Cancel simulation" : "Cancel test"}
        </Button>
      )}
      <p data-testid="exec-rehearsal-say" className="mt-2 text-sm text-ink">
        {simulation && r.state === "completed"
          ? "Finished. This is what the plan did in the replica."
          : copy.say}
        {r.detail && (r.state === "failed" || r.state === "cancelled") ? ` ${r.detail}` : ""}
      </p>
      {relation !== "current" && (
        <p className="mt-1 text-xs text-muted">
          This stays tied to revision {r.plan.revision}. Revision {current.revision} needs its own
          {simulation ? " simulation" : " test"}.
        </p>
      )}

      {(retryable || relation !== "current") && isTerminal(r.state) && (
        <>
          <Button
            size="sm"
            icon="play"
            className="mt-2"
            loading={retrying}
            disabled={retryBlocked !== null}
            onClick={onRetry}
          >
            {retryable ? "Try again" : simulation ? "Simulate" : "Run"} on revision{" "}
            {current.revision}
          </Button>
          {retryBlocked && (
            <p data-testid="exec-rehearsal-row-blocked" className="mt-1 text-xs text-muted">
              {retryBlocked}
            </p>
          )}
        </>
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
