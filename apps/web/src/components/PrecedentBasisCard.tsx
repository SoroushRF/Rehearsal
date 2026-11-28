import type { PrecedentBasis, PrecedentCitation, PrecedentRecallDrop } from "@rehearsal/contracts";
import type { RecallDiagnostics } from "../api";
import { shortHash } from "../format";
import { explainPrecedentHold, type PrecedentCheck, type PrecedentHold } from "../precedent-holds";
import type { Precedent } from "./PrecedentPanel";
import { Card, Chip, Icon } from "./ui";

/**
 * Where a citation came from, by the registry. The planner decoded the cited facts into a record
 * whose digest the citation carries; the registry holds the digest of the version finance
 * approved. The same id, version and digest means the facts are that approved version.
 */
export type CitationSource =
  | { kind: "not_loaded" }
  | { kind: "missing" }
  | { kind: "differs"; approved: Precedent }
  | { kind: "matched"; approved: Precedent };

export function citationSource(
  c: PrecedentCitation,
  registry: readonly Precedent[] | null,
): CitationSource {
  if (registry === null) return { kind: "not_loaded" };
  const approved = registry.find((p) => p.id === c.id && p.version === c.version);
  if (!approved) return { kind: "missing" };
  return { kind: approved.digest === c.digest ? "matched" : "differs", approved };
}

function SourceLine({ c, source }: { c: PrecedentCitation; source: CitationSource }) {
  const attrs = { "data-testid": "citation-source", "data-source": source.kind };
  switch (source.kind) {
    case "not_loaded":
      return (
        <p {...attrs} className="mt-1 text-xs text-subtle">
          Approved version not looked up here.
        </p>
      );
    case "missing":
      return (
        <p {...attrs} className="mt-1 text-sm text-warn">
          This organization never approved {c.id} v{c.version}: the cited facts trace to no
          approval.
        </p>
      );
    case "differs":
      return (
        <p {...attrs} className="mt-1 text-sm text-warn">
          The cited facts don't match approved {c.id} v{c.version} (digest{" "}
          <code className="font-mono">{shortHash(c.digest)}</code>, approved{" "}
          <code className="font-mono">{shortHash(source.approved.digest)}</code>).
        </p>
      );
    case "matched": {
      const p = source.approved;
      return (
        <p {...attrs} className="mt-1 text-xs text-subtle">
          These facts are approved v{p.version} (digest{" "}
          <code className="font-mono">{shortHash(p.digest)}</code>), promoted by{" "}
          <code className="font-mono">{p.author}</code> on {p.approvedAt.slice(0, 10)} from run{" "}
          <code className="font-mono">{p.sourceRunId ?? "none recorded"}</code>.
        </p>
      );
    }
  }
}

const DROPPED_BY: Record<PrecedentRecallDrop["stage"], string> = {
  recall: "Agent Memory's copy",
  registry: "the registry",
};

/**
 * Keys that stay unique when the server repeats an entry: each is the entry key plus how many times
 * it has come before, so what was sent is shown as is, repeats included.
 */
function keyed<T>(items: readonly T[], keyOf: (item: T) => string): [string, T][] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const k = keyOf(item);
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return [`${k}#${n}`, item];
  });
}

/**
 * T1.54: why each precedent was or wasn't recalled, as the planner recorded it beside the plan.
 * Per area: the query recall was sent, its trace, what it found with the stored facts, and what was
 * dropped and at which stage. Collapsed by default; it explains the citations and decides nothing.
 */
export function RecallDetail({
  recall,
  basis,
}: {
  recall: RecallDiagnostics;
  basis: PrecedentBasis;
}) {
  const { diagnostics } = recall;
  const cited = (id: string, version: number) =>
    basis.citations.some((c) => c.id === id && c.version === version);
  return (
    <details data-testid="recall-diagnostics" className="group mt-3 rounded-lg border border-line">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-sm font-medium text-muted hover:text-ink">
        <Icon name="chevron" className="h-4 w-4 transition-transform group-open:rotate-90" />
        Why these precedents
      </summary>
      <div className="border-t border-line px-3 py-2.5 text-sm">
        {!diagnostics.recalled ? (
          <p className="text-xs text-subtle">
            Nothing was active in the registry when this was planned, so Agent Memory wasn't asked.
          </p>
        ) : diagnostics.areas.length === 0 ? (
          <p className="text-xs text-subtle">No recall was recorded.</p>
        ) : (
          <ul className="space-y-3">
            {keyed(diagnostics.areas, (a) => a.area).map(([key, a]) => (
              <li key={key} data-testid="recall-area" data-area={a.area}>
                <p className="text-xs text-subtle">
                  <span className="font-medium text-ink">{a.area}</span>: recall asked{" "}
                  <code className="font-mono">&ldquo;{a.query}&rdquo;</code> · trace{" "}
                  <code className="font-mono">{a.traceId ?? "none recorded"}</code>
                </p>
                {a.hits.length === 0 && a.dropped.length === 0 && (
                  <p className="mt-1 text-xs text-subtle">Recall found nothing here.</p>
                )}
                {a.hits.length > 0 && (
                  <ul aria-label={`Found for ${a.area}`} className="mt-1 space-y-1">
                    {keyed(a.hits, (h) => `${h.id}@${h.version}`).map(([key, h]) => {
                      const isCited = cited(h.id, h.version);
                      return (
                        <li
                          key={key}
                          data-testid="recall-hit"
                          data-cited={isCited ? "true" : "false"}
                          className="text-xs text-subtle"
                        >
                          Found{" "}
                          <code className="font-mono text-ink">
                            {h.id} v{h.version}
                          </code>
                          {isCited ? ", cited" : ", not cited"}
                          {h.factIds.length > 0 && (
                            <>
                              {" "}
                              from facts{" "}
                              {keyed(h.factIds, (f) => f).map(([key, f], i) => (
                                <span key={key}>
                                  {i > 0 && " "}
                                  <code className="rounded bg-sunken px-1.5 py-0.5 font-mono">
                                    {f}
                                  </code>
                                </span>
                              ))}
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {a.dropped.length > 0 && (
                  <ul aria-label={`Dropped for ${a.area}`} className="mt-1 space-y-1">
                    {keyed(a.dropped, (d) => `${d.stage}:${d.id}`).map(([key, d]) => (
                      <li
                        key={key}
                        data-testid="recall-drop"
                        data-stage={d.stage}
                        className="text-xs text-warn"
                      >
                        Dropped <code className="font-mono">{d.id}</code> by {DROPPED_BY[d.stage]}:{" "}
                        {d.reason}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-subtle">
          Recorded when revision {recall.revision} was planned. This explains the citations; it
          doesn't decide what is cited or approved.
        </p>
      </div>
    </details>
  );
}

/**
 * The precedents a plan rests on, as the planner recalled them: which version, where it applies,
 * and the trace that found it. With the registry's verdict beside it, so a reviewer sees that a
 * cited precedent was replaced or withdrawn before they approve, not after. Without a verdict
 * (an example plan, or the check hasn't loaded) it says so instead of implying the citations hold.
 * Each citation traces through its facts to the approved version, who promoted it and the run it
 * came from (T2.31), and `recall` says why each precedent was or wasn't recalled (T1.54).
 */
export function PrecedentBasisCard({
  basis,
  check,
  registry = null,
  recall = null,
}: {
  basis: PrecedentBasis;
  /** The registry's answer for this exact plan; null when it wasn't asked. */
  check: PrecedentCheck | null;
  /** Every version this organization approved (`GET /api/precedents`); null when not loaded. */
  registry?: readonly Precedent[] | null;
  /** What the planner recorded about its recall; null for examples and plans made before T1.54. */
  recall?: RecallDiagnostics | null;
}) {
  const holds: PrecedentHold[] = check && !check.ok ? check.holds : [];
  const holdsFor = (id: string) => holds.filter((h) => "id" in h && h.id === id);
  const areaHolds = holds.filter((h) => !("id" in h));
  const none = basis.citations.length === 0;

  return (
    <Card data-testid="precedent-basis" className="p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="eye" className="h-4 w-4 text-subtle" />
        <h3 className="text-[15px] font-semibold text-ink">Precedents this plan rests on</h3>
        {check === null ? (
          <Chip tone="neutral" hint="Not compared with the registry here">
            Not checked
          </Chip>
        ) : check.ok ? (
          <Chip tone="good" icon="check" hint="Every cited version is still the one in force">
            All still in force
          </Chip>
        ) : (
          <Chip tone="warn" icon="clock">
            Changed since planning
          </Chip>
        )}
      </div>

      {none ? (
        <p className="mt-3 text-sm text-muted">
          The planner consulted precedents in {Object.keys(basis.epochs).join(", ") || "no area"}{" "}
          and cited none.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-line rounded-lg border border-line">
          {basis.citations.map((c) => {
            const mine = holdsFor(c.id);
            return (
              <li
                key={`${c.id}@${c.version}`}
                data-testid="citation"
                data-held={mine.length > 0 ? "true" : "false"}
                className="px-3 py-2.5 text-sm"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <code className="font-mono text-xs text-ink">
                    {c.id} v{c.version}
                  </code>
                  <span className="text-xs text-subtle">{c.appliesTo}</span>
                  {mine.length > 0 && <Chip tone="warn">Held</Chip>}
                </div>
                <p className="mt-1 text-xs text-subtle">
                  Found by trace <code className="font-mono">{c.traceId ?? "none recorded"}</code> ·{" "}
                  {c.factIds.length} stored fact{c.factIds.length === 1 ? "" : "s"}
                </p>
                {c.factIds.length > 0 && (
                  <ul
                    aria-label={`Fact IDs for ${c.id}`}
                    className="mt-1 flex flex-wrap gap-1 text-xs text-subtle"
                  >
                    {c.factIds.map((f) => (
                      <li key={f}>
                        <code className="rounded bg-sunken px-1.5 py-0.5 font-mono">{f}</code>
                      </li>
                    ))}
                  </ul>
                )}
                <SourceLine c={c} source={citationSource(c, registry)} />
                {mine.map((h) => (
                  <p key={explainPrecedentHold(h)} className="mt-1 text-sm text-warn">
                    {explainPrecedentHold(h)}
                  </p>
                ))}
              </li>
            );
          })}
        </ul>
      )}

      {recall && <RecallDetail recall={recall} basis={basis} />}

      {areaHolds.map((h) => (
        <p key={explainPrecedentHold(h)} className="mt-2 text-sm text-warn">
          {explainPrecedentHold(h)}
        </p>
      ))}
      {check !== null && !check.ok && (
        <p className="mt-2 text-xs text-subtle">
          Approval is refused until the plan is revised against the current precedents.
        </p>
      )}
    </Card>
  );
}
