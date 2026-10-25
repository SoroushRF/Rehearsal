import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { z } from "zod";
import { type ApiFetch, call, explain, RefusedError } from "../api";
import { humanize } from "../format";
import { useTenantKey } from "../identity";
import { Alert, Button, Card, Chip, type Tone } from "./ui";

const Status = z.enum(["waiting", "active", "superseded", "withdrawn"]);
type Status = z.infer<typeof Status>;

export const Precedent = z.object({
  id: z.string(),
  version: z.int(),
  appliesTo: z.string(),
  status: Status,
  statement: z.string(),
  conditions: z.array(z.string()),
  exceptions: z.array(z.string()),
  effectiveFrom: z.string(),
  effectiveUntil: z.string().nullable(),
  author: z.string(),
  approvedAt: z.string(),
});
export type Precedent = z.infer<typeof Precedent>;

export const PrecedentListResponse = z.object({
  precedents: z.array(Precedent),
  syncEnabled: z.boolean(),
});
const Promoted = z.object({ precedent: z.object({ id: z.string(), version: z.int() }) });
const Withdrawn = z.object({ precedent: z.object({ id: z.string(), version: z.int() }) });

/** What finance-only refusals mean here, in words. */
function refusalText(err: unknown, action: string): string {
  if (err instanceof RefusedError) {
    const r = err.refusal;
    if (r.error === "missing_roles") return `Only a finance lead can ${action}.`;
    if (r.error === "stale_version") {
      return `A newer version (v${String(r.activeVersion ?? "?")}) is active now. Reload and look at it first.`;
    }
    if (r.error === "not_active")
      return "That version isn't active, so there is nothing to withdraw.";
  }
  return explain(err);
}

const statusLabel: Record<Status, { text: string; tone: Tone; hint: string }> = {
  waiting: {
    text: "Waiting for sync",
    tone: "warn",
    hint: "Approved, but not yet stored and read back in Agent Memory. No plan uses it yet.",
  },
  active: { text: "Active", tone: "good", hint: "Stored and read back; plans can recall it." },
  superseded: { text: "Replaced", tone: "neutral", hint: "A newer version is active." },
  withdrawn: { text: "Withdrawn", tone: "neutral", hint: "No longer in force." },
};

/** One precedent per line of text; blank lines are dropped. */
const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** What the reviewer sees about each version: where it stands, and why nothing uses it yet. */
export function PrecedentRows({
  list,
  withdraw,
}: {
  list: z.infer<typeof PrecedentListResponse>;
  /** Present when the viewer may try to withdraw; the server still checks the role. */
  withdraw?: {
    pending: string | null;
    error: string | null;
    onWithdraw: (p: Precedent) => void;
  };
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  if (list.precedents.length === 0) {
    return <p className="text-sm text-muted">No precedents promoted yet.</p>;
  }
  return (
    <>
      <ul className="divide-y divide-line rounded-lg border border-line">
        {list.precedents.map((p) => {
          const s = statusLabel[p.status];
          return (
            <li
              key={`${p.id}@${p.version}`}
              data-testid="precedent"
              data-status={p.status}
              className="px-3 py-2.5"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <code className="font-mono text-xs text-ink">
                  {p.id} v{p.version}
                </code>
                <Chip tone={s.tone} hint={s.hint}>
                  {s.text}
                </Chip>
                <span className="text-xs text-subtle">
                  {humanize(p.appliesTo.replaceAll(".", " "))}
                </span>
              </div>
              <p className="mt-1 text-sm text-ink">{p.statement}</p>
              <p className="mt-0.5 text-xs text-subtle">
                From {p.effectiveFrom}
                {p.effectiveUntil ? ` until ${p.effectiveUntil}` : ""}, approved by {p.author}
              </p>
              {withdraw && p.status === "active" && (
                <WithdrawControl
                  label={`${p.id} v${p.version}`}
                  confirming={confirming === p.id}
                  pending={withdraw.pending === p.id}
                  onStart={() => setConfirming(p.id)}
                  onCancel={() => setConfirming(null)}
                  onConfirm={() => {
                    setConfirming(null);
                    withdraw.onWithdraw(p);
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>
      {withdraw?.error && <Alert className="mt-2">{withdraw.error}</Alert>}
      {!list.syncEnabled && list.precedents.some((p) => p.status === "waiting") && (
        <p className="mt-2 text-xs text-subtle" data-testid="sync-off">
          Agent Memory isn't set up on this server, so promoted precedents stay waiting and no plan
          uses them.
        </p>
      )}
    </>
  );
}

/** Withdrawing stops plans relying on a precedent, so it takes a second, explicit click. */
function WithdrawControl({
  label,
  confirming,
  pending,
  onStart,
  onCancel,
  onConfirm,
}: {
  label: string;
  confirming: boolean;
  pending: boolean;
  onStart: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!confirming) {
    return (
      <Button variant="secondary" size="sm" className="mt-2" loading={pending} onClick={onStart}>
        Withdraw
      </Button>
    );
  }
  return (
    <fieldset
      aria-label={`Withdraw ${label}`}
      className="mt-2 flex min-w-0 border-0 flex-wrap items-center gap-2 rounded-lg bg-warn-bg px-3 py-2 text-sm text-ink"
    >
      <span>Withdraw {label}? Plans that relied on it will be held. History keeps it.</span>
      <Button variant="primary" size="sm" onClick={onConfirm}>
        Confirm withdrawal
      </Button>
      <Button variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
    </fieldset>
  );
}

/**
 * Finance lead only: turn what happened in a completed run into a precedent, saying where it
 * applies, under what conditions, with what exceptions and from when. The server sets the author
 * and version; the precedent is only used by plans once Agent Memory has stored it.
 */
export function PrecedentPanel({
  apiFetch,
  runId,
  completed,
}: {
  apiFetch: ApiFetch;
  runId: string;
  completed: boolean;
}) {
  const queryClient = useQueryClient();
  const key = useTenantKey();
  const [open, setOpen] = useState(false);
  const list = useQuery({
    queryKey: key("precedents"),
    queryFn: () => call(apiFetch, PrecedentListResponse, "/api/precedents"),
    enabled: open,
  });
  const [form, setForm] = useState({
    id: "",
    appliesTo: "billing.duplicate_charge",
    statement: "",
    conditions: "",
    exceptions: "",
    effectiveFrom: new Date().toISOString().slice(0, 10),
    effectiveUntil: "",
  });
  const set = (field: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  const promote = useMutation({
    mutationFn: () =>
      call(apiFetch, Promoted, `/api/runs/${encodeURIComponent(runId)}/precedents`, {
        id: form.id.trim(),
        appliesTo: form.appliesTo.trim(),
        statement: form.statement.trim(),
        conditions: lines(form.conditions),
        exceptions: lines(form.exceptions),
        effectiveFrom: form.effectiveFrom,
        effectiveUntil: form.effectiveUntil || null,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key("precedents") }),
  });
  const withdraw = useMutation({
    mutationFn: (p: Precedent) =>
      call(apiFetch, Withdrawn, `/api/precedents/${encodeURIComponent(p.id)}/withdraw`, {
        version: p.version,
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key("precedents") }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    promote.mutate();
  };

  const field =
    "mt-1 w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-ink";
  const label = "block text-xs font-medium text-muted";
  const refusal = promote.isError ? refusalText(promote.error, "promote a precedent") : null;

  return (
    <details
      data-testid="precedent-panel"
      className="group rounded-xl border border-line bg-surface shadow-card"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-muted hover:text-ink sm:px-5">
        Precedents: promote what this run decided
      </summary>
      <div className="flex flex-col gap-4 border-t border-line p-4 sm:p-5">
        {completed ? (
          <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
            <label className={label}>
              Name (a short slug)
              <input
                required
                className={field}
                value={form.id}
                onChange={set("id")}
                placeholder="duplicate-charge-refund"
              />
            </label>
            <label className={label}>
              Applies to
              <input
                required
                className={field}
                value={form.appliesTo}
                onChange={set("appliesTo")}
              />
            </label>
            <label className={`${label} sm:col-span-2`}>
              What was decided
              <textarea
                required
                rows={2}
                className={field}
                value={form.statement}
                onChange={set("statement")}
              />
            </label>
            <label className={label}>
              Conditions (one per line)
              <textarea
                rows={3}
                className={field}
                value={form.conditions}
                onChange={set("conditions")}
              />
            </label>
            <label className={label}>
              Exceptions (one per line)
              <textarea
                rows={3}
                className={field}
                value={form.exceptions}
                onChange={set("exceptions")}
              />
            </label>
            <label className={label}>
              In force from
              <input
                required
                type="date"
                className={field}
                value={form.effectiveFrom}
                onChange={set("effectiveFrom")}
              />
            </label>
            <label className={label}>
              Until (leave empty if open-ended)
              <input
                type="date"
                className={field}
                value={form.effectiveUntil}
                onChange={set("effectiveUntil")}
              />
            </label>
            <div className="sm:col-span-2">
              <Button type="submit" variant="primary" loading={promote.isPending}>
                Promote to precedent
              </Button>
              <p className="mt-2 text-xs text-subtle">
                You are named as the author. It is used by plans only after it has been stored in
                Agent Memory and read back.
              </p>
            </div>
            {refusal && <Alert className="sm:col-span-2">{refusal}</Alert>}
            {promote.data && (
              <Alert tone="good" className="sm:col-span-2" data-testid="promoted">
                {promote.data.precedent.id} v{promote.data.precedent.version} approved. It is
                waiting for Agent Memory.
              </Alert>
            )}
          </form>
        ) : (
          <p className="text-sm text-muted">
            A precedent can be promoted from a completed run. This run hasn't completed.
          </p>
        )}
        <Card className="p-4 shadow-none">
          <h4 className="mb-2 text-xs font-semibold tracking-wider text-subtle uppercase">
            This organization's precedents
          </h4>
          {list.isError && <Alert>{explain(list.error)}</Alert>}
          {list.data && (
            <PrecedentRows
              list={list.data}
              withdraw={{
                pending: withdraw.isPending ? (withdraw.variables?.id ?? null) : null,
                error: withdraw.isError
                  ? refusalText(withdraw.error, "withdraw a precedent")
                  : null,
                onWithdraw: (p) => withdraw.mutate(p),
              }}
            />
          )}
        </Card>
      </div>
    </details>
  );
}
