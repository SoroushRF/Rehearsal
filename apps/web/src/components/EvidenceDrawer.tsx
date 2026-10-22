import type { Action, PlanManifest, QueryPredicate } from "@rehearsal/contracts";
import { useEffect } from "react";
import { shortHash } from "../format";
import { evidenceFor } from "../plan";

/** What the planner read before proposing this action. Apply re-checks every item listed here. */
export function EvidenceDrawer({
  manifest,
  action,
  onClose,
}: {
  manifest: PlanManifest;
  action: Action;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { observations, queries, missing } = evidenceFor(manifest, action);
  return (
    <aside
      aria-label={`Evidence for ${action.id}`}
      data-testid="evidence-drawer"
      className="fixed inset-y-0 right-0 z-10 w-full max-w-md overflow-y-auto border-l border-slate-200 bg-white p-5 shadow-xl"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Evidence</h2>
          <p className="font-mono text-xs text-slate-500">{action.id}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-50"
        >
          Close
        </button>
      </div>
      <p className="mt-3 text-sm text-slate-600">
        Read in the planning world. Before this step runs, apply re-reads each record and re-runs
        each query; any difference holds the step.
      </p>

      {missing.length > 0 && (
        <p role="alert" className="mt-4 rounded bg-rose-50 p-2 text-sm text-rose-800">
          Cited but missing from the plan: {missing.join(", ")}
        </p>
      )}

      {observations.length > 0 && <h3 className="mt-5 text-sm font-semibold">Records</h3>}
      {observations.map((o) => (
        <section key={o.id} className="mt-2 rounded border border-slate-200 p-3">
          <p className="text-sm font-medium">
            {o.entity.vendor} {o.entity.kind} <code className="font-mono">{o.entity.id}</code>
          </p>
          <Fields fields={o.projection} />
          <Meta
            items={[o.id, o.projectionVersion, `fp ${shortHash(o.fingerprint)}`, o.capturedAt]}
          />
        </section>
      ))}

      {queries.length > 0 && <h3 className="mt-5 text-sm font-semibold">Queries</h3>}
      {queries.map((q) => (
        <section key={q.id} className="mt-2 rounded border border-slate-200 p-3">
          <p className="text-sm font-medium">{describePredicate(q.predicate)}</p>
          <p className="mt-1 text-sm">
            {q.matchingIds.length} match{q.matchingIds.length === 1 ? "" : "es"}
            {q.matchingIds.length > 0 && (
              <>
                : <code className="font-mono text-xs">{q.matchingIds.join(", ")}</code>
              </>
            )}
          </p>
          {!q.complete && (
            <p className="mt-1 text-sm text-amber-800">
              Incomplete enumeration: not proof that nothing else matches.
            </p>
          )}
          <Meta items={[q.id, `as of ${q.cutoff}`, `fp ${shortHash(q.fingerprint)}`]} />
        </section>
      ))}
    </aside>
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
    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
      {Object.entries(fields).map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-slate-500">{k}</dt>
          <dd className="font-mono text-xs leading-5 break-all">{JSON.stringify(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function Meta({ items }: { items: string[] }) {
  return <p className="mt-2 font-mono text-[0.7rem] text-slate-400">{items.join(" · ")}</p>;
}
