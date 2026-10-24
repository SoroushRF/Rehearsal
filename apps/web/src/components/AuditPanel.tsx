import { PlanManifest, Receipt, Sha256Hex } from "@rehearsal/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { type ApiFetch, call, explain } from "../api";
import { formatMoney, roleLabel, shortHash } from "../format";
import { useTenantKey } from "../identity";
import { explainReceipt, RunView } from "../runs";
import { Alert, Card, Chip, Icon, Skeleton } from "./ui";

const Role = z.enum(["support_lead", "finance_lead"]);

/** `GET /api/runs/:id/audit`: stored history only, as the API assembles it. */
export const Audit = z.object({
  source: z.literal("stored_history"),
  run: RunView,
  plan: z.object({
    planId: z.string(),
    revision: z.int(),
    planHash: Sha256Hex,
    manifest: PlanManifest,
  }),
  policies: z.array(z.object({ id: z.string(), version: z.int(), contents: z.unknown() })),
  grants: z.array(
    z.object({
      id: z.string(),
      actorUserId: z.string(),
      roles: z.array(Role),
      grantedAt: z.string(),
      expiresAt: z.string(),
      revokedAt: z.string().nullable(),
      usedByRun: z.boolean(),
    }),
  ),
  attempts: z.array(
    z.object({
      id: z.string(),
      actionId: z.string(),
      attemptNo: z.int(),
      state: z.string(),
      providerStatus: z.int().nullable(),
      error: z.string().nullable(),
      preparedAt: z.string(),
      settledAt: z.string().nullable(),
    }),
  ),
  receipts: z.array(z.object({ id: z.string(), actionId: z.string(), receipt: Receipt })),
});
export type Audit = z.infer<typeof Audit>;

/** Opens on demand, so the page only reads the audit of a run someone asks about. */
export function AuditPanel({ apiFetch, runId }: { apiFetch: ApiFetch; runId: string }) {
  const key = useTenantKey();
  const [open, setOpen] = useState(false);
  const audit = useQuery({
    queryKey: key("audit", runId),
    queryFn: () => call(apiFetch, Audit, `/api/runs/${encodeURIComponent(runId)}/audit`),
    enabled: open,
  });
  return (
    <details
      data-testid="audit-panel"
      className="group rounded-xl border border-line bg-surface shadow-card"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-muted hover:text-ink sm:px-5">
        <Icon name="chevron" className="h-4 w-4 transition-transform group-open:rotate-90" />
        Audit: exactly what was approved for this run
      </summary>
      <div className="border-t border-line p-4 sm:p-5">
        {audit.isPending && open && <Skeleton className="h-40" />}
        {audit.isError && <Alert>{explain(audit.error)}</Alert>}
        {audit.data && <AuditView audit={audit.data} />}
      </div>
    </details>
  );
}

const time = (iso: string) => new Date(iso).toLocaleString();

export function AuditView({ audit }: { audit: Audit }) {
  const { plan, run } = audit;
  const refunds = plan.manifest.actions.flatMap((a) =>
    a.kind === "stripe.refund.create" ? [a.args.amount] : [],
  );
  return (
    <div className="flex flex-col gap-5 text-sm">
      <p className="flex flex-wrap items-center gap-2 text-muted">
        <Chip tone="neutral" icon="clock">
          Saved history
        </Chip>
        Read from what was stored when the plan was approved and run. Nothing here is re-read from a
        provider or from today's policy.
      </p>

      <Section title="Plan">
        <p className="text-muted">
          {plan.manifest.incidentId}, revision {plan.revision}, hash{" "}
          <code className="font-mono text-xs break-all text-ink" title={plan.planHash}>
            {shortHash(plan.planHash)}
          </code>
          . Run {run.id} applied it.
        </p>
        <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
          {plan.manifest.actions.map((a) => (
            <li key={a.id} className="flex flex-wrap items-baseline gap-x-3 px-3 py-2">
              <code className="font-mono text-xs text-ink">{a.id}</code>
              <span className="text-muted">{a.kind}</span>
              {a.kind === "stripe.refund.create" && (
                <span className="tnum font-medium text-ink">{formatMoney(a.args.amount)}</span>
              )}
              <span className="text-subtle">
                needs {roleLabel[a.requiredRole]} · cites{" "}
                {a.evidence.length + a.queryEvidence.length} record
                {a.evidence.length + a.queryEvidence.length === 1 ? "" : "s"}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-subtle">
          {plan.manifest.observations.length} stored observation
          {plan.manifest.observations.length === 1 ? "" : "s"} and{" "}
          {plan.manifest.queryObservations.length} stored quer
          {plan.manifest.queryObservations.length === 1 ? "y" : "ies"} back these steps
          {refunds.length > 0 ? `, ${refunds.length} of them refunds` : ""}.
        </p>
      </Section>

      <Section title="Policy as approved">
        {audit.policies.map((p) => (
          <div key={`${p.id}@${p.version}`} className="mb-2">
            <p className="font-medium text-ink">
              {p.id} version {p.version}
            </p>
            {p.contents === null || p.contents === undefined ? (
              <p className="mt-1 text-muted" data-testid="policy-not-recorded">
                The contents weren't recorded for this approval (it was made before approvals kept
                them), so they are not shown. Today's policy file may differ.
              </p>
            ) : (
              <pre className="mt-1 overflow-x-auto rounded-lg bg-sunken p-3 font-mono text-xs leading-5 text-ink">
                {JSON.stringify(p.contents, null, 2)}
              </pre>
            )}
          </div>
        ))}
      </Section>

      <Section title="Approvals">
        <ul className="divide-y divide-line rounded-lg border border-line">
          {audit.grants.map((g) => (
            <li key={g.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2">
              <span className="font-medium text-ink">{g.actorUserId}</span>
              <span className="text-muted">{g.roles.map((r) => roleLabel[r]).join(" + ")}</span>
              <span className="text-subtle">
                approved {time(g.grantedAt)}, expires {time(g.expiresAt)}
              </span>
              {g.revokedAt && <Chip tone="warn">Revoked {time(g.revokedAt)}</Chip>}
              {g.usedByRun && <Chip tone="accent">Used by this run</Chip>}
            </li>
          ))}
        </ul>
      </Section>

      <Section title={`Sends (${audit.attempts.length})`}>
        {audit.attempts.length === 0 ? (
          <p className="text-muted">Nothing was sent.</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {audit.attempts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline gap-x-3 px-3 py-2">
                <code className="font-mono text-xs text-ink">{a.actionId}</code>
                <span className="text-muted">attempt {a.attemptNo}</span>
                <span className="text-subtle">
                  {a.state}
                  {a.providerStatus !== null ? `, provider answered ${a.providerStatus}` : ""}
                  {a.error ? `, ${a.error}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Receipts (${audit.receipts.length})`}>
        {audit.receipts.length === 0 ? (
          <p className="text-muted">No step has a receipt.</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {audit.receipts.map((r) => (
              <li key={r.id} className="px-3 py-2">
                <code className="font-mono text-xs text-ink">{r.actionId}</code>{" "}
                <span className="text-muted">{explainReceipt(r.receipt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <Card className="p-4 shadow-none">
    <h4 className="mb-2 text-xs font-semibold tracking-wider text-subtle uppercase">{title}</h4>
    {children}
  </Card>
);
