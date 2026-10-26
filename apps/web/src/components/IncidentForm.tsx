import { IncidentDraft, type IncidentKind, StoredIncident } from "@rehearsal/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { z } from "zod";
import { type ApiFetch, call, explain, RefusedError, routeMissing } from "../api";
import { incidentFixtures } from "../fixtures";
import { useTenantKey } from "../identity";
import { KIND_LABEL } from "./CompanyOverview";
import { Alert, Button, Chip, Skeleton } from "./ui";

const IncidentList = z.array(StoredIncident);
type Incidents = { incidents: StoredIncident[]; fixture: boolean };

/** `GET /api/incidents`, newest first; the labelled fixtures while the route isn't deployed. */
function useIncidents(apiFetch: ApiFetch) {
  const key = useTenantKey();
  return useQuery({
    queryKey: key("incidents"),
    queryFn: async (): Promise<Incidents> => {
      try {
        return { incidents: await call(apiFetch, IncidentList, "/api/incidents"), fixture: false };
      } catch (err) {
        if (routeMissing(err)) return { incidents: incidentFixtures, fixture: true };
        throw err;
      }
    },
  });
}

/** A `YYYY-MM-DD` date input as the UTC midnight that starts that day. */
const dayStart = (day: string) => new Date(`${day}T00:00:00.000Z`);
const nextDay = (day: string) => new Date(dayStart(day).getTime() + 86_400_000);
const dayOf = (iso: string) => iso.slice(0, 10);
/** The last day a window includes; `createdLt` is exclusive. */
const lastDayOf = (createdLt: string) =>
  new Date(new Date(createdLt).getTime() - 86_400_000).toISOString().slice(0, 10);

const field =
  "mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-subtle";
const label = "text-xs font-medium tracking-wider text-subtle uppercase";

/**
 * Files an incident for the org (kind, title, description, the dates it covers) and lists the
 * org's incidents. Rehearsing one sends only its ID: the server builds the planner's brief.
 */
export function IncidentForm({
  apiFetch,
  kinds,
  allowed,
  active,
  onRehearse,
}: {
  apiFetch: ApiFetch;
  /** The kinds this deployment can plan; the others aren't offered. */
  kinds: readonly IncidentKind[];
  /** False without `rehearsal:rehearse:incident`: the list is still readable. */
  allowed: boolean;
  /** The incident the plans page is rehearsing. */
  active: string;
  onRehearse: (incidentId: string) => void;
}) {
  const key = useTenantKey();
  const queryClient = useQueryClient();
  const incidents = useIncidents(apiFetch);
  const [kind, setKind] = useState<IncidentKind>(kinds[0] ?? "duplicate_charge");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [from, setFrom] = useState("2026-09-01");
  const [to, setTo] = useState("2026-09-30");
  const [invalid, setInvalid] = useState<string | null>(null);

  const file = useMutation({
    mutationFn: (draft: IncidentDraft) => call(apiFetch, StoredIncident, "/api/incidents", draft),
    onSuccess: () => {
      setTitle("");
      setDescription("");
      queryClient.invalidateQueries({ queryKey: key("incidents") });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setInvalid(null);
    if (!from || !to || dayStart(from) > dayStart(to)) {
      setInvalid("The window ends before it starts.");
      return;
    }
    const draft = IncidentDraft.safeParse({
      kind,
      title,
      description,
      window: { createdGte: dayStart(from).toISOString(), createdLt: nextDay(to).toISOString() },
    });
    if (!draft.success) {
      setInvalid("Title needs 3–120 characters, description 10–2000.");
      return;
    }
    file.mutate(draft.data);
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <form aria-label="File an incident" className="flex flex-col gap-4" onSubmit={submit}>
        <h2 className="text-2xl text-ink">File an incident</h2>
        <fieldset>
          <legend className={label}>Kind</legend>
          <div className="mt-1 inline-flex max-w-full gap-1 overflow-x-auto rounded-lg bg-sunken p-1">
            {kinds.map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={k === kind}
                onClick={() => setKind(k)}
                className="h-8 rounded-md px-3 text-[13px] font-medium whitespace-nowrap text-muted hover:text-ink aria-pressed:bg-surface aria-pressed:text-ink aria-pressed:shadow-card"
              >
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
        </fieldset>
        <label className="block">
          <span className={label}>Title</span>
          <input
            className={field}
            value={title}
            maxLength={120}
            required
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="block">
          <span className={label}>Description</span>
          <textarea
            className={`${field} min-h-24 resize-y`}
            value={description}
            maxLength={2000}
            required
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={label}>From</span>
            <input
              type="date"
              className={`${field} font-mono tnum`}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className="block">
            <span className={label}>To</span>
            <input
              type="date"
              className={`${field} font-mono tnum`}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
        </div>
        <Button
          type="submit"
          variant="primary"
          loading={file.isPending}
          disabled={!allowed}
          title={allowed ? undefined : "You don't have permission to file an incident"}
        >
          File incident
        </Button>
        {invalid && <Alert>{invalid}</Alert>}
        {file.isError && <Alert>{fileRefusal(file.error)}</Alert>}
        {file.data && (
          <Alert tone="good" data-testid="incident-filed">
            Filed <code className="font-mono">{file.data.incidentId}</code>.
          </Alert>
        )}
      </form>

      <section aria-label="Incidents" className="flex min-w-0 flex-col gap-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-2xl text-ink">Incidents</h2>
          {incidents.data?.fixture && <Chip tone="neutral">fixture</Chip>}
        </div>
        {incidents.isPending ? (
          <div aria-busy="true" className="flex flex-col gap-2">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        ) : incidents.isError ? (
          <Alert>{explain(incidents.error)}</Alert>
        ) : (
          <IncidentRows
            incidents={incidents.data.incidents}
            active={active}
            allowed={allowed}
            onRehearse={onRehearse}
          />
        )}
      </section>
    </div>
  );
}

export function IncidentRows({
  incidents,
  active,
  allowed,
  onRehearse,
}: {
  incidents: readonly StoredIncident[];
  active: string;
  allowed: boolean;
  onRehearse: (incidentId: string) => void;
}) {
  if (incidents.length === 0) return <p className="py-10 text-center text-sm text-subtle">None</p>;
  return (
    <ul className="flex flex-col">
      {incidents.map((i) => (
        <li
          key={i.incidentId}
          data-testid="incident-row"
          data-incident={i.incidentId}
          aria-current={i.incidentId === active ? "true" : undefined}
          className="flex flex-col gap-2 border-t border-line py-3 first:border-t-0 sm:flex-row sm:items-start sm:justify-between aria-[current=true]:shadow-[inset_3px_0_0_var(--lime)] aria-[current=true]:pl-3"
        >
          <div className="min-w-0">
            <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-mono text-[13px] text-ink">{i.incidentId}</span>
              <span className="text-xs text-subtle">{KIND_LABEL[i.kind]}</span>
              <span className="font-mono text-xs text-subtle tnum">
                {dayOf(i.window.createdGte)} – {lastDayOf(i.window.createdLt)}
              </span>
            </p>
            <p className="mt-0.5 text-sm font-medium text-ink">{i.title}</p>
            <p className="mt-0.5 line-clamp-2 text-sm text-muted">{i.description}</p>
          </div>
          <Button
            size="sm"
            variant={i.incidentId === active ? "primary" : "secondary"}
            icon="play"
            disabled={!allowed}
            className="shrink-0 self-start"
            onClick={() => onRehearse(i.incidentId)}
          >
            Rehearse
          </Button>
        </li>
      ))}
    </ul>
  );
}

function fileRefusal(err: unknown): string {
  if (routeMissing(err)) return "Filing incidents isn't deployed here yet.";
  if (err instanceof RefusedError && err.refusal.error === "invalid_window")
    return "The window ends before it starts.";
  if (err instanceof RefusedError && err.refusal.error === "invalid_request")
    return "Title needs 3–120 characters, description 10–2000.";
  return explain(err);
}
