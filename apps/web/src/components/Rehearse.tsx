import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { z } from "zod";
import { type ApiFetch, call, explain } from "../api";
import { useTenantKey } from "../identity";

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

/**
 * Starts a rehearsal (the planner works in the planning world and stores a plan) and follows it
 * until the plan is stored or fails. Each click spends model tokens, so only one runs at a time.
 */
export function RehearseBar({
  apiFetch,
  onStored,
}: {
  apiFetch: ApiFetch;
  onStored: (planId: string) => void;
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
    <section
      aria-label="Rehearse"
      className="rounded-lg border border-slate-200 bg-white p-4 text-sm"
    >
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={running}
          onClick={() => {
            setRehearsalId(null);
            start.mutate();
          }}
          className="rounded bg-slate-900 px-3 py-1.5 font-medium text-white disabled:opacity-50"
        >
          Rehearse {INCIDENT_ID}
        </button>
        <span className="text-slate-600">
          The agent plans in a copy of the company. Nothing reaches production until you approve.
          Each run uses model tokens.
        </span>
      </div>

      {start.isError && <Note tone="bad">{explain(start.error)}</Note>}
      {status.isError && <Note tone="bad">{explain(status.error)}</Note>}
      {r && (
        <p data-testid="rehearsal-state" data-state={r.state} className="mt-3">
          <strong>{say[r.state]}</strong>
          {r.state === "failed" || r.state === "retrying" ? <> {failure(r)}</> : null}
        </p>
      )}
      {r?.state === "stored" && r.summary && (
        <p className="mt-1 text-slate-600">Planner's summary: {r.summary}</p>
      )}
    </section>
  );
}

function failure(r: Rehearsal) {
  const reason = r.error?.reason === undefined ? "" : String(r.error.reason);
  const message = r.error?.message === undefined ? "" : String(r.error.message);
  return [reason, message].filter(Boolean).join(": ") || "No reason was recorded.";
}

function Note({ children, tone }: { children: string; tone: "bad" }) {
  return (
    <p role="alert" data-tone={tone} className="mt-3 rounded bg-rose-50 p-2 text-rose-800">
      {children}
    </p>
  );
}
