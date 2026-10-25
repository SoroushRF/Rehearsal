import type { QueryPredicate } from "@rehearsal/contracts";
import { useEffect, useRef } from "react";
import { shortHash } from "../format";
import { evidenceFor, type ReviewAction, type ReviewManifest } from "../plan";
import { Alert, Button, Chip, Icon } from "./ui";

/** What the planner read before proposing this action. Apply re-checks every item listed here. */
export function EvidenceDrawer({
  manifest,
  action,
  onClose,
}: {
  manifest: ReviewManifest;
  action: ReviewAction;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    // Keyboard users land on the panel, and it is what a screen reader reads next.
    closeRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { observations, queries, missing } = evidenceFor(manifest, action);
  return (
    <>
      {/* Click outside to close. The page behind stays readable. */}
      <div
        aria-hidden
        onClick={onClose}
        className="fixed inset-0 z-40 bg-ink/25 backdrop-blur-[1px] sm:bg-ink/15"
      />
      <aside
        aria-label={`Evidence for ${action.id}`}
        data-testid="evidence-drawer"
        className="drawer-enter fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-line bg-surface shadow-raised"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-lg leading-6 font-semibold text-ink">Evidence</h2>
            <p className="mt-0.5 text-xs text-subtle">
              For step <code className="font-mono text-muted">{action.id}</code>
            </p>
          </div>
          <Button
            ref={closeRef}
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close evidence"
          >
            <Icon name="x" />
            Close
          </Button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
          <p className="rounded-xl bg-sunken p-3.5 text-[13px] leading-5 text-muted">
            This is what the planner read in the planning world. Before this step runs, apply reads
            each record again and re-runs each query. Any difference holds the step.
          </p>

          {missing.length > 0 && (
            <Alert tone="danger" title="Cited but missing from the plan">
              {missing.join(", ")}
            </Alert>
          )}

          {observations.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-semibold tracking-wider text-subtle uppercase">
                Records ({observations.length})
              </h3>
              <div className="space-y-3">
                {observations.map((o) => (
                  <article key={o.id} className="rounded-xl border border-line p-4">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-ink capitalize">
                        {o.entity.vendor} {o.entity.kind}
                      </p>
                      <code className="font-mono text-xs text-muted">{o.entity.id}</code>
                    </div>
                    <Fields fields={o.projection} />
                    <Meta
                      items={[
                        o.id,
                        o.projectionVersion,
                        `fp ${shortHash(o.fingerprint)}`,
                        o.capturedAt,
                      ]}
                    />
                  </article>
                ))}
              </div>
            </section>
          )}

          {queries.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-semibold tracking-wider text-subtle uppercase">
                Queries ({queries.length})
              </h3>
              <div className="space-y-3">
                {queries.map((q) => (
                  <article key={q.id} className="rounded-xl border border-line p-4">
                    <p className="text-sm font-semibold text-ink">
                      {describePredicate(q.predicate)}
                    </p>
                    <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted">
                      <Chip tone={q.matchingIds.length > 1 ? "warn" : "good"}>
                        {q.matchingIds.length} match{q.matchingIds.length === 1 ? "" : "es"}
                      </Chip>
                      {q.matchingIds.length > 0 && (
                        <code className="font-mono text-xs break-all">
                          {q.matchingIds.join(", ")}
                        </code>
                      )}
                    </p>
                    {!q.complete && (
                      <Alert tone="warn" className="mt-3">
                        Incomplete enumeration: not proof that nothing else matches.
                      </Alert>
                    )}
                    <Meta items={[q.id, `as of ${q.cutoff}`, `fp ${shortHash(q.fingerprint)}`]} />
                  </article>
                ))}
              </div>
            </section>
          )}
        </div>
      </aside>
    </>
  );
}

function describePredicate(p: QueryPredicate): string {
  switch (p.kind) {
    case "stripe.charges.byCustomerInWindow":
      return `Stripe charges for ${p.customerId}, ${p.createdGte.slice(0, 10)} to ${p.createdLt.slice(0, 10)}`;
    case "zendesk.tickets.byRequester":
      return `Zendesk tickets requested by ${p.requesterId}`;
  }
}

function Fields({ fields }: { fields: Record<string, unknown> }) {
  return (
    <dl className="mt-3 divide-y divide-line rounded-lg bg-sunken px-3 text-sm">
      {Object.entries(fields).map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-4 py-1.5">
          <dt className="text-muted">{k}</dt>
          <dd className="tnum text-right font-mono text-xs leading-5 break-all text-ink">
            {JSON.stringify(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Meta({ items }: { items: string[] }) {
  return (
    <p className="mt-3 font-mono text-[11px] leading-4 break-all text-subtle">
      {items.join(" · ")}
    </p>
  );
}
