import type { PlanManifest } from "@rehearsal/contracts";
import { type ReactNode, useCallback, useState } from "react";
import { formatMoney, roleLabel, shortHash, sumMoney } from "../format";
import { droppedBy, groupByCase, requiredRoles } from "../plan";
import type { PrecedentCheck } from "../precedent-holds";
import { ActionRow } from "./ActionRow";
import { EvidenceDrawer } from "./EvidenceDrawer";
import { PrecedentBasisCard } from "./PrecedentBasisCard";
import { Card, Chip, CopyButton, Icon, Stat } from "./ui";

/**
 * The whole job on one page: every effect, grouped by customer, with the hash being approved.
 * With `review`, the reviewer can uncheck actions; dependents drop with them in the preview.
 * `actions` is the approval panel (live plans only); it sits under the summary on wide screens and
 * after the steps on narrow ones.
 */
export function PlanReview({
  manifest,
  planHash,
  evidence,
  review,
  actions,
  precedents = null,
}: {
  manifest: PlanManifest;
  planHash: string;
  /** A bundle's evidence label; null for a stored plan, which shows who planned it instead. */
  evidence: "fixture" | "era_integration" | null;
  review?: { unchecked: ReadonlySet<string>; onToggle: (actionId: string) => void };
  actions?: ReactNode;
  /** The registry's verdict on the precedents the plan cites; null when not asked (examples). */
  precedents?: PrecedentCheck | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const dropped = review ? droppedBy(manifest.actions, review.unchecked) : new Set<string>();
  const close = useCallback(() => setSelectedId(null), []);
  const cases = groupByCase(manifest);
  const refunds = sumMoney(cases.flatMap((c) => c.refunds));
  const credits = sumMoney(cases.flatMap((c) => c.credits));
  const irreversible = manifest.actions.filter((a) => a.compensation === "irreversible").length;
  const selected = manifest.actions.find((a) => a.id === selectedId);
  const roles = requiredRoles(manifest);

  return (
    <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_21.5rem] lg:gap-x-8 lg:gap-y-6">
      {/* Title */}
      <header className="review-heading order-1 lg:col-span-2">
        <p className="workspace-label">Billing operations / Plan review</p>
        <div className="review-title">
          <h2>{manifest.incidentId}</h2>
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip tone="neutral">
              Revision {manifest.revision}
              {manifest.parentRevision !== null && ` (from ${manifest.parentRevision})`}
            </Chip>
            {evidence === "fixture" ? (
              <Chip tone="warn" icon="flask" hint="Not yet run against real Era images">
                Fixture
              </Chip>
            ) : evidence === "era_integration" ? (
              <Chip tone="good" icon="check">
                Ran on Era
              </Chip>
            ) : (
              <Chip tone="accent" icon="spark" hint="Planner model and prompt version">
                planned by {manifest.versions.planner.model} ·{" "}
                {manifest.versions.planner.promptVersion}
              </Chip>
            )}
          </div>
        </div>
        <div className="review-context">
          <p>
            Plan <code className="font-mono text-muted">{manifest.planId}</code>
          </p>
          <p>
            {review
              ? "Review each effect before signing."
              : "Inspect the plan and the evidence behind each effect."}
          </p>
        </div>
        <ol className="review-stage" aria-label="Plan and apply process">
          <li>
            <span className="stage-number">01</span>Plan
          </li>
          <li aria-current="step">
            <span className="stage-number">02</span>Review
          </li>
          <li>
            <span className="stage-number">03</span>Apply
          </li>
        </ol>
      </header>

      {/* Steps, grouped by customer */}
      <div className="order-3 flex min-w-0 flex-col gap-5 lg:order-none lg:col-start-1 lg:row-start-2">
        <p className="workspace-label">Planned effects · {cases.length} customer cases</p>
        {cases.map((c, index) => (
          <Card
            key={c.caseId}
            data-testid="case-card"
            data-case-id={c.caseId}
            className="ledger-section overflow-hidden"
          >
            <div className="ledger-customer">
              <div className="flex min-w-0 items-center gap-3">
                <span className="ledger-index">{String(index + 1).padStart(2, "0")}</span>
                <div className="min-w-0">
                  <h3 className="truncate text-[15px] leading-5 font-semibold text-ink">
                    {c.customerId ?? "Unknown customer"}
                  </h3>
                  <p className="text-xs text-subtle">
                    <span className="font-mono">{c.caseId}</span> · {c.actions.length}{" "}
                    {c.actions.length === 1 ? "step" : "steps"}
                  </p>
                </div>
              </div>
              <div className="text-right">
                <p className="tnum text-lg leading-6 font-semibold text-ink">
                  {[...c.refunds, ...c.credits].map(formatMoney).join(" + ") || "No refund"}
                </p>
                {(c.refunds.length > 0 || c.credits.length > 0) && (
                  <p className="text-xs text-subtle">
                    {[
                      c.refunds.length > 0 ? "to refund" : "",
                      c.credits.length > 0 ? "as invoice credit" : "",
                    ]
                      .filter(Boolean)
                      .join(", ")}
                  </p>
                )}
              </div>
            </div>
            <ul className="divide-y divide-line">
              {c.actions.map((a) => (
                <ActionRow
                  key={a.id}
                  action={a}
                  selected={a.id === selectedId}
                  onShowEvidence={() => setSelectedId(a.id === selectedId ? null : a.id)}
                  dependsOnLabels={a.dependsOn}
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
          </Card>
        ))}

        {manifest.precedentBasis && (
          <PrecedentBasisCard basis={manifest.precedentBasis} check={precedents} />
        )}

        {manifest.excluded.length > 0 && (
          <Card className="border-dashed bg-transparent p-4 shadow-none sm:p-5">
            <h3 className="text-sm font-semibold text-ink">Excluded from this revision</h3>
            <ul className="mt-2 space-y-1.5 text-sm text-muted">
              {manifest.excluded.map((e) => (
                <li key={e.actionId} className="flex flex-wrap items-center gap-2">
                  <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-xs">
                    {e.actionId}
                  </code>
                  {e.reason === "reviewer"
                    ? "unchecked by the reviewer"
                    : "dropped with a step it depended on"}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      {/* Summary, then the approval panel */}
      <div className="review-sidebar contents lg:sticky lg:top-24 lg:col-start-2 lg:row-start-2 lg:block lg:max-h-[calc(100dvh-7rem)] lg:self-start lg:overflow-y-auto lg:pb-1">
        <Card className="ledger-summary order-2 p-5 lg:order-none">
          <p className="workspace-label">Total refunds</p>
          <p className="ledger-summary-amount tnum text-ink">
            {refunds.map(formatMoney).join(" + ") || "None"}
          </p>
          <p className="ledger-summary-note">
            {review
              ? "Your signature covers the effects in this exact revision."
              : "This is a read-only plan. Live plans require a signed approval before apply."}
          </p>
          {credits.length > 0 && (
            <p className="mt-1 text-sm text-muted">
              Plus{" "}
              <span className="tnum font-medium text-ink">
                {credits.map(formatMoney).join(" + ")}
              </span>{" "}
              credited to next invoices
            </p>
          )}

          <dl className="mt-5 grid grid-cols-3 gap-3 border-t border-line pt-4">
            <Stat label="Customers" value={cases.length} />
            <Stat label="Steps" value={manifest.actions.length} />
            <Stat
              label="Irreversible"
              value={<span className={irreversible > 0 ? "text-danger" : ""}>{irreversible}</span>}
              hint="steps"
            />
          </dl>

          <div className="mt-4 border-t border-line pt-4">
            <p className="text-xs font-semibold tracking-wider text-subtle uppercase">
              Needs sign-off
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {roles.map((r) => (
                <Chip key={r} tone={r === "finance_lead" ? "info" : "neutral"} icon="users">
                  {roleLabel[r]}
                </Chip>
              ))}
            </div>
          </div>

          <div className="mt-4 border-t border-line pt-4">
            <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wider text-subtle uppercase">
              <Icon name="hash" className="h-3.5 w-3.5" />
              Plan hash
            </p>
            <p className="mt-1.5 flex items-center gap-1">
              <code
                data-testid="plan-hash"
                title={planHash}
                className="rounded-md bg-sunken px-2 py-1 font-mono text-[13px] text-ink"
              >
                {shortHash(planHash)}
              </code>
              <CopyButton value={planHash} label="Copy full plan hash" />
            </p>
            <p className="mt-1.5 text-xs leading-4 text-subtle">
              An approval binds to exactly this hash. Any change makes a new revision that needs a
              new approval.
            </p>
          </div>
        </Card>

        {actions && <div className="order-4 lg:order-none lg:mt-4">{actions}</div>}
      </div>

      {selected && <EvidenceDrawer manifest={manifest} action={selected} onClose={close} />}
    </div>
  );
}
