import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { z } from "zod";
import { type ApiFetch, call, explain, RefusedError } from "../api";
import { useTenantKey } from "../identity";
import { Alert, Button, Card, Icon, Spinner } from "./ui";

/**
 * The one incident this deployment can rehearse (scenarios/billing/incident.v1.json). The API
 * refuses anything else; there is no list of incidents to read it from yet.
 */
export const INCIDENT_ID = "INC-BILL-0927";

const Started = z.object({ rehearsalId: z.string(), planId: z.string(), state: z.string() });
const Rehearsal = z.object({
  rehearsalId: z.string(),
  planId: z.string(),
  state: z.enum(["queued", "planning", "retrying", "stored", "failed"]),
  error: z.object({ reason: z.unknown().optional(), message: z.unknown().optional() }).optional(),
  planHash: z.string().optional(),
  summary: z.string().optional(),
});
type Rehearsal = z.infer<typeof Rehearsal>;

const POLL_MS = 2000;
const done = (r: Rehearsal | undefined) => r?.state === "stored" || r?.state === "failed";

const say: Record<Rehearsal["state"], string> = {
  queued: "Waiting for the planner to pick this up…",
  planning: "The agent is planning in the copy of the company…",
  retrying: "The first attempt failed; trying once more…",
  stored: "Plan stored.",
  failed: "Planning failed.",
};

const STEPS = ["Queued", "Planning", "Plan stored"] as const;
/** How far along the three steps a state is; a failure stops at the step it failed on. */
const reached = (s: Rehearsal["state"]) => (s === "queued" ? 0 : s === "stored" ? 2 : 1);

/**
 * Starts a rehearsal (the planner works in the planning world and stores a plan) and follows it
 * until the plan is stored or fails. Each click spends model tokens, so only one runs at a time.
 */
export function RehearseBar({
  apiFetch,
  onStored,
  allowed = true,
}: {
  apiFetch: ApiFetch;
  onStored: (planId: string) => void;
  /** False when the signed-in person lacks `rehearsal:rehearse:incident`. */
  allowed?: boolean;
}) {
  const queryClient = useQueryClient();
  const key = useTenantKey();
  const [rehearsalId, setRehearsalId] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: () =>
      call(apiFetch, Started, `/api/incidents/${encodeURIComponent(INCIDENT_ID)}/rehearse`, {}),
    onSuccess: (s) => setRehearsalId(s.rehearsalId),
  });
  const status = useQuery({
    queryKey: key("rehearsal", rehearsalId),
    enabled: rehearsalId !== null,
    queryFn: () =>
      call(apiFetch, Rehearsal, `/api/rehearsals/${encodeURIComponent(rehearsalId ?? "")}`),
    refetchInterval: (q) => (done(q.state.data) ? false : POLL_MS),
  });
  const r = status.data;

  const storedPlanId = r?.state === "stored" ? r.planId : null;
  useEffect(() => {
    if (!storedPlanId) return;
    queryClient.invalidateQueries({ queryKey: key("plans") });
    onStored(storedPlanId);
  }, [storedPlanId, queryClient, key, onStored]);

  const running = start.isPending || (rehearsalId !== null && !done(r));
  return (
    <Card aria-label="Rehearse" className="p-4 sm:p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <Icon name="flask" className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-[15px] leading-6 font-semibold text-ink">Rehearse an incident</h2>
            <p className="text-sm leading-5 text-muted">
              The agent plans in a copy of the company. Nothing reaches production until you
              approve. Each run uses model tokens.
            </p>
          </div>
        </div>
        <Button
          variant="primary"
          icon="play"
          loading={running}
          disabled={!allowed}
          title={allowed ? undefined : "You don't have permission to rehearse an incident"}
          onClick={() => {
            setRehearsalId(null);
            start.mutate();
          }}
        >
          Rehearse {INCIDENT_ID}
        </Button>
      </div>

      {!allowed && (
        <p className="mt-3 text-sm text-muted">
          You don't have permission to rehearse an incident.
        </p>
      )}
      {start.isError && <Alert className="mt-4">{rehearseRefusal(start.error)}</Alert>}
      {status.isError && <Alert className="mt-4">{explain(status.error)}</Alert>}

      {r && (
        <div className="mt-4 border-t border-line pt-4">
          <Steps state={r.state} />
          <p data-testid="rehearsal-state" data-state={r.state} className="mt-3 text-sm text-ink">
            <strong className="font-semibold">{say[r.state]}</strong>
            {r.state === "failed" || r.state === "retrying" ? <> {failure(r)}</> : null}
          </p>
          {r.state === "stored" && r.summary && (
            <p className="mt-1 text-sm leading-5 text-muted">Planner's summary: {r.summary}</p>
          )}
        </div>
      )}
    </Card>
  );
}

function Steps({ state }: { state: Rehearsal["state"] }) {
  const at = reached(state);
  const failed = state === "failed";
  return (
    <ol className="flex items-center gap-2" aria-label="Rehearsal progress">
      {STEPS.map((label, i) => {
        const complete = i < at || (state === "stored" && i === 2);
        const current = i === at && !complete;
        const bad = failed && current;
        return (
          <li key={label} className="flex min-w-0 flex-1 items-center gap-2 last:flex-none">
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                bad
                  ? "bg-danger-bg text-danger"
                  : complete
                    ? "bg-ok text-surface"
                    : current
                      ? "bg-accent text-on-accent"
                      : "bg-sunken text-subtle"
              }`}
              aria-current={current ? "step" : undefined}
            >
              {bad ? (
                <Icon name="x" className="h-3.5 w-3.5" />
              ) : complete ? (
                <Icon name="check" className="h-3.5 w-3.5" />
              ) : current && !failed ? (
                <Spinner className="h-3.5 w-3.5" />
              ) : (
                i + 1
              )}
            </span>
            <span
              className={`text-[13px] whitespace-nowrap ${current || complete ? "font-medium text-ink" : "text-subtle"}`}
            >
              {label}
            </span>
            {i < STEPS.length - 1 && (
              <span
                className={`h-px flex-1 ${complete ? "bg-ok" : "bg-line-strong"}`}
                aria-hidden
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** A 403 on starting a rehearsal stays the sentence the review page already shows. */
function rehearseRefusal(err: unknown): string {
  if (
    err instanceof RefusedError &&
    (err.status === 403 ||
      err.refusal.error === "forbidden" ||
      err.refusal.error === "missing_roles")
  ) {
    return "Your role can read plans but not ask for a rehearsal.";
  }
  return explain(err);
}

function failure(r: Rehearsal) {
  const reason = r.error?.reason === undefined ? "" : String(r.error.reason);
  const message = r.error?.message === undefined ? "" : String(r.error.message);
  return [reason, message].filter(Boolean).join(": ") || "No reason was recorded.";
}
