import type { PlanManifest } from "@rehearsal/contracts";
import { useCallback, useState } from "react";
import { formatMoney, roleLabel, shortHash, sumMoney } from "../format";
import { droppedBy, groupByCase, requiredRoles } from "../plan";
import { ActionRow } from "./ActionRow";
import { Badge } from "./Badge";
import { EvidenceDrawer } from "./EvidenceDrawer";

/**
 * The whole job on one page: every effect, grouped by customer, with the hash being approved.
 * With `review`, the reviewer can uncheck actions; dependents drop with them in the preview.
 */
export function PlanReview({
  manifest,
  planHash,
  evidence,
  review,
}: {
  manifest: PlanManifest;
  planHash: string;
  /** A bundle's evidence label; null for a stored plan, which shows who planned it instead. */
  evidence: "fixture" | "era_integration" | null;
  review?: { unchecked: ReadonlySet<string>; onToggle: (actionId: string) => void };
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const dropped = review ? droppedBy(manifest.actions, review.unchecked) : new Set<string>();
  const close = useCallback(() => setSelectedId(null), []);
  const cases = groupByCase(manifest);
  const refunds = sumMoney(cases.flatMap((c) => c.refunds));
  const irreversible = manifest.actions.filter((a) => a.compensation === "irreversible").length;
  const selected = manifest.actions.find((a) => a.id === selectedId);

  return (
    <div>
      <header className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">
            {manifest.incidentId} · {manifest.planId}
          </h2>
          <Badge tone="neutral">
            revision {manifest.revision}
            {manifest.parentRevision !== null && ` (from ${manifest.parentRevision})`}
          </Badge>
          {evidence === "fixture" ? (
            <Badge tone="warn" hint="Not yet run against real Era images">
              Fixture
            </Badge>
          ) : evidence === "era_integration" ? (
            <Badge tone="good">Ran on Era</Badge>
          ) : (
            <Badge tone="neutral" hint="Planner model and prompt version">
              planned by {manifest.versions.planner.model} ·{" "}
              {manifest.versions.planner.promptVersion}
            </Badge>
          )}
        </div>
        <p className="mt-2 text-sm text-slate-600">
          Plan hash{" "}
          <code data-testid="plan-hash" title={planHash} className="font-mono text-slate-900">
            {shortHash(planHash)}
          </code>
          <span className="text-slate-400"> · approval binds to exactly this hash</span>
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Stat label="Customers" value={String(cases.length)} />
          <Stat label="Refunds" value={refunds.map(formatMoney).join(" + ") || "none"} />
          <Stat
            label="Actions"
            value={`${manifest.actions.length} (${irreversible} irreversible)`}
          />
          <Stat
            label="Must sign"
            value={requiredRoles(manifest)
              .map((r) => roleLabel[r])
              .join(", ")}
          />
        </dl>
      </header>

      {cases.map((c) => (
        <section
          key={c.caseId}
          data-testid="case-card"
          data-case-id={c.caseId}
          className="mt-4 overflow-hidden rounded-lg border border-slate-200 bg-white"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2">
            <h3 className="font-medium">
              {c.customerId ?? "Unknown customer"}{" "}
              <span className="font-mono text-xs font-normal text-slate-500">{c.caseId}</span>
            </h3>
            <span className="text-sm tabular-nums text-slate-600">
              {c.refunds.map(formatMoney).join(" + ") || "no refund"}
            </span>
          </div>
          <ul className="divide-y divide-slate-100">
            {c.actions.map((a) => (
              <ActionRow
                key={a.id}
                action={a}
                selected={a.id === selectedId}
                onShowEvidence={() => setSelectedId(a.id === selectedId ? null : a.id)}
                {...(review && {
                  include: {
                    unchecked: review.unchecked.has(a.id),
                    droppedWithDependency: dropped.has(a.id) && !review.unchecked.has(a.id),
                    onToggle: () => review.onToggle(a.id),
                  },
                })}
              />
            ))}
          </ul>
        </section>
      ))}

      {manifest.excluded.length > 0 && (
        <section className="mt-4 rounded-lg border border-dashed border-slate-300 p-4 text-sm">
          <h3 className="font-medium">Excluded from this revision</h3>
          <ul className="mt-1 text-slate-600">
            {manifest.excluded.map((e) => (
              <li key={e.actionId}>
                <code className="font-mono">{e.actionId}</code>{" "}
                {e.reason === "reviewer" ? "unchecked by reviewer" : "dropped with its dependency"}
              </li>
            ))}
          </ul>
        </section>
      )}

      {selected && <EvidenceDrawer manifest={manifest} action={selected} onClose={close} />}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}
