import {
  type CompanySnapshot,
  CompanySnapshot as CompanySnapshotSchema,
  type IncidentKind,
} from "@rehearsal/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { type ApiFetch, call, explain, routeMissing } from "../api";
import { companyFixture } from "../fixtures";
import { formatMoney } from "../format";
import { useTenantKey } from "../identity";
import { Alert, Button, Chip, Skeleton } from "./ui";

/** The overview as shown: the server's snapshot, or the labelled fixture while the route isn't deployed. */
type Company = { snapshot: CompanySnapshot; fixture: boolean };

/** `GET /api/company`. A first load for a new org seeds its world, so it can take a few seconds. */
export function useCompany(apiFetch: ApiFetch) {
  const key = useTenantKey();
  return useQuery({
    queryKey: key("company"),
    queryFn: async (): Promise<Company> => {
      try {
        return {
          snapshot: await call(apiFetch, CompanySnapshotSchema, "/api/company"),
          fixture: false,
        };
      } catch (err) {
        if (routeMissing(err)) return { snapshot: companyFixture, fixture: true };
        throw err;
      }
    },
  });
}

const TABS = ["charges", "customers", "tickets", "slack"] as const;
type Tab = (typeof TABS)[number];
const tabLabel: Record<Tab, string> = {
  charges: "Charges",
  customers: "Customers",
  tickets: "Tickets",
  slack: "Slack",
};

/** Each tab's records by the ID `changed` uses (ticket IDs as strings, Slack messages by ts). */
const idsOf = (s: CompanySnapshot, tab: Tab): string[] =>
  tab === "charges"
    ? s.charges.map((c) => c.id)
    : tab === "customers"
      ? s.customers.map((c) => c.id)
      : tab === "tickets"
        ? s.tickets.map((t) => String(t.id))
        : s.slack.map((m) => m.ts);

export const KIND_LABEL: Record<IncidentKind, string> = {
  duplicate_charge: "Duplicate charge",
  support_backlog: "Support backlog",
  service_outage: "Service outage",
};

/**
 * The signed-in org's own company: its operational world, read-only. Rows a run's receipt changed
 * carry a lime marker and the run; where the previous load had the row, the old value is shown.
 */
export function CompanyOverview({
  apiFetch,
  kinds,
  canCreateProblem,
  onOpenRun,
}: {
  apiFetch: ApiFetch;
  /** Problem presets offered: the incident kinds this deployment can plan. */
  kinds: readonly IncidentKind[];
  canCreateProblem: boolean;
  onOpenRun: (runId: string) => void;
}) {
  const company = useCompany(apiFetch);
  const [tab, setTab] = useState<Tab>("charges");
  const previous = usePreviousSnapshot(company.data?.snapshot);

  if (company.isPending) return <OverviewSkeleton />;
  if (company.isError) return <Alert>{explain(company.error)}</Alert>;
  const { snapshot, fixture } = company.data;

  return (
    <section aria-label="Company" className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-2xl text-ink">Company</h2>
          <span className="font-mono text-xs whitespace-nowrap text-subtle tnum">
            {new Date(snapshot.asOf).toLocaleString()}
          </span>
          {fixture && <Chip tone="neutral">fixture</Chip>}
        </div>
        {canCreateProblem && !fixture && (
          <div className="flex flex-wrap items-center gap-2">
            <CreateProblem apiFetch={apiFetch} kinds={kinds} />
            <ResetWorld apiFetch={apiFetch} />
          </div>
        )}
      </div>

      <div
        role="tablist"
        aria-label="Records"
        className="-mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 sm:-mx-1 sm:px-1"
      >
        {TABS.map((t) => {
          const ids = idsOf(snapshot, t);
          const marked = ids.some((id) => id in snapshot.changed);
          return (
            <button
              key={t}
              type="button"
              role="tab"
              id={`tab-${t}`}
              aria-selected={t === tab}
              aria-controls={`panel-${t}`}
              onClick={() => setTab(t)}
              className="relative -mb-px flex shrink-0 items-center gap-1.5 border-b-2 border-transparent px-2.5 py-2 text-sm whitespace-nowrap text-muted hover:text-ink aria-selected:border-ink aria-selected:text-ink sm:gap-2 sm:px-3"
            >
              {tabLabel[t]}
              <span className="font-mono text-xs text-subtle tnum">{ids.length}</span>
              {marked && (
                <>
                  <span className="h-1.5 w-1.5 rounded-full bg-lime" aria-hidden />
                  <span className="sr-only">changed by a run</span>
                </>
              )}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "charges" && <Charges s={snapshot} prev={previous} onOpenRun={onOpenRun} />}
        {tab === "customers" && <Customers s={snapshot} prev={previous} onOpenRun={onOpenRun} />}
        {tab === "tickets" && <Tickets s={snapshot} prev={previous} onOpenRun={onOpenRun} />}
        {tab === "slack" && <Slack s={snapshot} onOpenRun={onOpenRun} />}
      </div>
    </section>
  );
}

/** The snapshot loaded before the current one, so a refetch after a run can show old → new. */
function usePreviousSnapshot(current: CompanySnapshot | undefined) {
  const last = useRef<CompanySnapshot | undefined>(undefined);
  const [previous, setPrevious] = useState<CompanySnapshot | undefined>(undefined);
  useEffect(() => {
    if (!current || current.asOf === last.current?.asOf) return;
    setPrevious(last.current);
    last.current = current;
  }, [current]);
  return previous;
}

type RowsProps = {
  s: CompanySnapshot;
  prev?: CompanySnapshot | undefined;
  onOpenRun: (runId: string) => void;
};

function Charges({ s, prev, onOpenRun }: RowsProps) {
  const before = new Map(prev?.charges.map((c) => [c.id, c]));
  return (
    <Table
      head={[
        { label: "Charge" },
        { label: "Customer", hide: "md" },
        { label: "Invoice", hide: "md" },
        { label: "Amount", right: true },
        { label: "Refunded", right: true, hide: "sm" },
      ]}
      empty={s.charges.length === 0}
    >
      {s.charges.map((c) => {
        const old = before.get(c.id);
        const refunded = (
          <Delta
            old={
              old && old.refundedMinor !== c.refundedMinor
                ? formatMoney({ amountMinor: old.refundedMinor, currency: c.currency })
                : null
            }
          >
            {c.refundedMinor === 0
              ? "—"
              : formatMoney({ amountMinor: c.refundedMinor, currency: c.currency })}
          </Delta>
        );
        return (
          <Row key={c.id} id={c.id} lead={c.id} run={s.changed[c.id]} onOpenRun={onOpenRun}>
            <Cell mono hide="md">
              {c.customer}
            </Cell>
            <Cell mono hide="md">
              {c.invoice ?? "—"}
            </Cell>
            <Cell mono right>
              {formatMoney({ amountMinor: c.amountMinor, currency: c.currency })}
              {(c.refundedMinor > 0 || (old && old.refundedMinor !== c.refundedMinor)) && (
                <span className="mt-0.5 block text-xs text-subtle sm:hidden">
                  <span className="font-sans">Refunded </span>
                  {refunded}
                </span>
              )}
            </Cell>
            <Cell mono right hide="sm">
              {refunded}
            </Cell>
          </Row>
        );
      })}
    </Table>
  );
}

function Balance({ minor }: { minor: number }) {
  // Negative is credit owed to the customer; formatted from its magnitude, still integer minor units.
  if (minor === 0) return <>—</>;
  const text = formatMoney({ amountMinor: Math.abs(minor), currency: "cad" });
  return minor < 0 ? <span className="text-accent">{text} credit</span> : <>{text}</>;
}

function Customers({ s, prev, onOpenRun }: RowsProps) {
  const before = new Map(prev?.customers.map((c) => [c.id, c]));
  return (
    <Table
      head={[
        { label: "Customer" },
        { label: "Email", hide: "md" },
        { label: "Balance", right: true },
      ]}
      empty={s.customers.length === 0}
    >
      {s.customers.map((c) => {
        const old = before.get(c.id);
        return (
          <Row key={c.id} id={c.id} lead={c.id} run={s.changed[c.id]} onOpenRun={onOpenRun}>
            <Cell hide="md">{c.email ?? "—"}</Cell>
            <Cell mono right>
              <Delta
                old={
                  old && old.balanceMinor !== c.balanceMinor ? (
                    <Balance minor={old.balanceMinor} />
                  ) : null
                }
              >
                <Balance minor={c.balanceMinor} />
              </Delta>
            </Cell>
          </Row>
        );
      })}
    </Table>
  );
}

function Tickets({ s, prev, onOpenRun }: RowsProps) {
  const before = new Map(prev?.tickets.map((t) => [t.id, t]));
  return (
    <Table
      head={[
        { label: "Ticket" },
        { label: "Subject" },
        { label: "Status", hide: "md" },
        { label: "Priority" },
        { label: "Requester", hide: "lg" },
        { label: "Updated", hide: "lg" },
      ]}
      empty={s.tickets.length === 0}
    >
      {s.tickets.map((t) => {
        const old = before.get(t.id);
        return (
          <Row
            key={t.id}
            id={String(t.id)}
            lead={`#${t.id}`}
            run={s.changed[String(t.id)]}
            onOpenRun={onOpenRun}
          >
            <Cell>{t.subject}</Cell>
            <Cell hide="md">
              <Delta old={old && old.status !== t.status ? old.status : null}>{t.status}</Delta>
            </Cell>
            <Cell>
              <Delta old={old && old.priority !== t.priority ? (old.priority ?? "—") : null}>
                {t.priority ?? "—"}
              </Delta>
            </Cell>
            <Cell hide="lg">{t.requester}</Cell>
            <Cell mono nowrap hide="lg">
              {new Date(t.updatedAt).toLocaleString()}
            </Cell>
          </Row>
        );
      })}
    </Table>
  );
}

function Slack({ s, onOpenRun }: Omit<RowsProps, "prev">) {
  return (
    <Table
      head={[{ label: "Channel" }, { label: "Time", hide: "md" }, { label: "Message" }]}
      empty={s.slack.length === 0}
    >
      {s.slack.map((m) => (
        <Row key={m.ts} id={m.ts} lead={m.channel} run={s.changed[m.ts]} onOpenRun={onOpenRun}>
          <Cell mono nowrap hide="md">
            {slackTime(m.ts)}
          </Cell>
          <Cell>{m.text}</Cell>
        </Row>
      ))}
    </Table>
  );
}

/** Slack's `ts` is epoch seconds with a sequence suffix. */
function slackTime(ts: string) {
  const seconds = Number(ts.split(".")[0]);
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toLocaleString() : ts;
}

/** Below this width a column is hidden, so the page never scrolls sideways on a phone. */
type Hide = "sm" | "md" | "lg";
const hidden: Record<Hide, string> = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
};
/** Tighter cells on phones; the first keeps room for the changed marker. */
const pad = "px-2 py-2.5 first:pl-3 sm:px-3";

function Table({
  head,
  empty,
  children,
}: {
  head: { label: string; hide?: Hide; right?: boolean }[];
  empty: boolean;
  children: ReactNode;
}) {
  if (empty) return <p className="py-10 text-center text-sm text-subtle">None</p>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs tracking-wider text-subtle uppercase">
          {head.map((h) => (
            <th
              key={h.label}
              scope="col"
              className={`${pad} py-2 font-medium ${h.hide ? hidden[h.hide] : ""} ${h.right ? "text-right" : ""}`}
            >
              {h.label}
            </th>
          ))}
          <th scope="col" className={`w-0 ${pad} py-2 ${hidden.md}`}>
            <span className="sr-only">Run</span>
          </th>
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

/**
 * One record. `lead` is its first cell (the ID); a run that changed it is linked in its own
 * column on wide screens and under the ID on phones.
 */
function Row({
  id,
  lead,
  run,
  onOpenRun,
  children,
}: {
  id: string;
  lead: ReactNode;
  run: string | undefined;
  onOpenRun: (runId: string) => void;
  children: ReactNode;
}) {
  const link = (className: string) =>
    run && (
      <button
        type="button"
        title={run}
        aria-label={run}
        onClick={() => onOpenRun(run)}
        className={`font-mono whitespace-nowrap text-accent underline decoration-line-strong underline-offset-2 hover:decoration-accent ${className}`}
      >
        {shortRun(run)}
      </button>
    );
  return (
    <tr
      data-testid="company-row"
      data-id={id}
      data-changed={run ? "true" : "false"}
      className={`border-t border-line align-top ${run ? "enter bg-accent-soft/40 shadow-[inset_4px_0_0_var(--lime)]" : ""}`}
    >
      <td className={`${pad} font-mono text-[13px] whitespace-nowrap text-ink tnum`}>
        {lead}
        {link("mt-1 block text-left text-xs md:hidden")}
      </td>
      {children}
      <td className={`${pad} text-right whitespace-nowrap ${hidden.md}`}>
        {link("align-top text-[13px] leading-5")}
      </td>
    </tr>
  );
}

/** Run IDs are long (`run_` + a UUID); the link shows the start, the title the whole ID. */
const shortRun = (runId: string) => (runId.length > 14 ? `${runId.slice(0, 12)}…` : runId);

function Cell({
  mono,
  right,
  nowrap,
  hide,
  children,
}: {
  mono?: boolean;
  right?: boolean;
  /** Dates and times stay on one line. */
  nowrap?: boolean;
  hide?: Hide;
  children: ReactNode;
}) {
  return (
    <td
      className={`${pad} ${mono ? "font-mono text-[13px] tnum" : ""} ${right ? "text-right" : ""} ${nowrap ? "whitespace-nowrap" : ""} ${hide ? hidden[hide] : ""} break-words text-ink`}
    >
      {children}
    </td>
  );
}

/** `old → new` where the value changed since the previous load; just the value otherwise. */
function Delta({ old, children }: { old: ReactNode | null; children: ReactNode }) {
  if (old === null) return <>{children}</>;
  return (
    <span className="inline-flex flex-wrap items-baseline justify-end gap-x-1">
      <span className="whitespace-nowrap text-subtle line-through">{old}</span>
      <span className="whitespace-nowrap">
        <span className="text-subtle" aria-hidden>
          →{" "}
        </span>
        <span className="sr-only">changed to </span>
        {children}
      </span>
    </span>
  );
}

function OverviewSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading company"
      className="flex flex-col gap-4"
    >
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-9 w-full max-w-md" />
      <div className="flex flex-col gap-2">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    </div>
  );
}

/**
 * Seeds a realistic problem into the org's own world (e.g. three customers charged twice), so the
 * incident filed next has something to find. Hidden where the route isn't deployed.
 */
function CreateProblem({
  apiFetch,
  kinds,
}: {
  apiFetch: ApiFetch;
  kinds: readonly IncidentKind[];
}) {
  const key = useTenantKey();
  const queryClient = useQueryClient();
  const [preset, setPreset] = useState<IncidentKind>(kinds[0] ?? "duplicate_charge");
  const [count, setCount] = useState(3);
  const [missing, setMissing] = useState(false);
  const create = useMutation({
    mutationFn: () => call(apiFetch, z.unknown(), "/api/company/problems", { preset, count }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key("company") }),
    onError: (err) => {
      if (routeMissing(err)) setMissing(true);
    },
  });
  if (missing) return null;

  const field = "h-8 rounded-lg border border-line bg-surface px-2 text-[13px] text-ink";
  return (
    <form
      aria-label="Create a problem"
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:flex"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <label className="sr-only" htmlFor="problem-preset">
        Problem
      </label>
      <select
        id="problem-preset"
        className={field}
        value={preset}
        onChange={(e) => setPreset(e.target.value as IncidentKind)}
      >
        {kinds.map((k) => (
          <option key={k} value={k}>
            {KIND_LABEL[k]}
          </option>
        ))}
      </select>
      <label className="sr-only" htmlFor="problem-count">
        Count
      </label>
      <select
        id="problem-count"
        className={`${field} font-mono tnum`}
        value={count}
        onChange={(e) => setCount(Number(e.target.value))}
      >
        {[1, 2, 3, 4, 5].map((n) => (
          <option key={n} value={n}>
            ×{n}
          </option>
        ))}
      </select>
      <Button
        type="submit"
        variant="secondary"
        size="sm"
        loading={create.isPending}
        className="col-span-2 sm:col-auto"
      >
        Create problem
      </Button>
      {create.isError && !routeMissing(create.error) && (
        <Alert className="col-span-2 w-full">{explain(create.error)}</Alert>
      )}
    </form>
  );
}

/**
 * Puts the org's own world back to the seeded company: every created problem and applied write
 * there goes. Plans and runs stay. Asks once before it does it; hidden where the route isn't deployed.
 */
function ResetWorld({ apiFetch }: { apiFetch: ApiFetch }) {
  const key = useTenantKey();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [missing, setMissing] = useState(false);
  const reset = useMutation({
    mutationFn: () => call(apiFetch, z.unknown(), "/api/company/reset", {}),
    onSuccess: () => {
      setConfirming(false);
      return queryClient.invalidateQueries({ queryKey: key("company") });
    },
    onError: (err) => {
      if (routeMissing(err)) setMissing(true);
    },
  });
  if (missing) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {confirming ? (
        <>
          <Button
            variant="secondary"
            size="sm"
            loading={reset.isPending}
            onClick={() => reset.mutate()}
          >
            Reset world
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={reset.isPending}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </Button>
        </>
      ) : (
        <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
          Reset
        </Button>
      )}
      {reset.isError && !routeMissing(reset.error) && (
        <Alert className="w-full">{explain(reset.error)}</Alert>
      )}
    </div>
  );
}
