import type { PrecedentBasis, PrecedentCitation } from "@rehearsal/contracts";
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

/**
 * The precedents a plan rests on, as the planner recalled them: which version, where it applies,
 * and the trace that found it. With the registry's verdict beside it, so a reviewer sees that a
 * cited precedent was replaced or withdrawn before they approve, not after. Without a verdict
 * (an example plan, or the check hasn't loaded) it says so instead of implying the citations hold.
 * Each citation traces through its facts to the approved version, who promoted it and the run it
 * came from (T2.29).
 */
export function PrecedentBasisCard({
  basis,
  check,
  registry = null,
}: {
  basis: PrecedentBasis;
  /** The registry's answer for this exact plan; null when it wasn't asked. */
  check: PrecedentCheck | null;
  /** Every version this organization approved (`GET /api/precedents`); null when not loaded. */
  registry?: readonly Precedent[] | null;
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
