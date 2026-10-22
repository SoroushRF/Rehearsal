import type { Action, CompensationClass, ProtectionLevel } from "@rehearsal/contracts";
import type { ReactNode } from "react";
import { compensationLabel, formatMoney, protectionLabel, roleLabel } from "../format";
import { Badge, type Tone } from "./Badge";

const compensationTone: Record<CompensationClass, Tone> = {
  conditional_reversible: "good",
  compensable_by_new_action: "warn",
  irreversible: "danger",
};

const protectionTone: Record<ProtectionLevel, Tone> = {
  native_guard_with_documented_limits: "neutral",
  best_effort_reread: "warn",
  no_atomic_guard: "warn",
};

/** Diff-style marker: `$` moves money, `~` edits a field, `+` appends something permanent. */
const marker: Record<Action["kind"], string> = {
  "stripe.refund.create": "$",
  "zendesk.ticket.patchFields": "~",
  "zendesk.ticket.appendPrivateNote": "+",
};

/** Present only when the reviewer can uncheck actions (a live plan, not a fixture). */
export interface IncludeControl {
  /** The reviewer unchecked this action. */
  unchecked: boolean;
  /** Dropped because something it depends on was unchecked. */
  droppedWithDependency: boolean;
  onToggle: () => void;
}

export function ActionRow({
  action,
  selected,
  onShowEvidence,
  include,
}: {
  action: Action;
  selected: boolean;
  onShowEvidence: () => void;
  include?: IncludeControl;
}) {
  const comp = compensationLabel[action.compensation];
  const prot = protectionLabel[action.protection];
  const dropped = include && (include.unchecked || include.droppedWithDependency);
  return (
    <li
      data-testid="action-row"
      data-action-id={action.id}
      data-dropped={dropped ? "true" : undefined}
      className={`flex gap-3 px-4 py-3 ${selected ? "bg-sky-50" : ""} ${dropped ? "opacity-50" : ""}`}
    >
      {include ? (
        <input
          type="checkbox"
          aria-label={`Include ${action.id}`}
          checked={!dropped}
          // A dependent can't be re-included on its own; re-check what it depends on instead.
          disabled={include.droppedWithDependency && !include.unchecked}
          onChange={include.onToggle}
          className="mt-1 h-4 w-4 shrink-0"
        />
      ) : null}
      <span aria-hidden className="w-4 shrink-0 pt-0.5 font-mono text-slate-400">
        {marker[action.kind]}
      </span>
      <div className={`min-w-0 flex-1 ${dropped ? "line-through decoration-slate-400" : ""}`}>
        <p className="font-medium text-slate-900">
          <Summary action={action} />
        </p>
        <p className="mt-0.5 text-sm text-slate-600">{action.rationale}</p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Badge
            tone={action.requiredRole === "finance_lead" ? "info" : "neutral"}
            hint="Role that must approve this step"
          >
            {roleLabel[action.requiredRole]}
          </Badge>
          <Badge tone={compensationTone[action.compensation]} hint={comp.hint}>
            {comp.text}
          </Badge>
          <Badge tone={protectionTone[action.protection]} hint={prot.hint}>
            {prot.text}
          </Badge>
          {action.dependsOn.length > 0 && (
            <span className="text-xs text-slate-500">after {action.dependsOn.join(", ")}</span>
          )}
          <span className="font-mono text-xs text-slate-400">{action.id}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={onShowEvidence}
        aria-pressed={selected}
        className="h-fit shrink-0 rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
      >
        Evidence ({action.evidence.length + action.queryEvidence.length})
      </button>
    </li>
  );
}

function Summary({ action }: { action: Action }) {
  switch (action.kind) {
    case "stripe.refund.create":
      return (
        <>
          Refund <span className="tabular-nums">{formatMoney(action.args.amount)}</span> on charge{" "}
          <Code>{action.args.chargeId}</Code>
          <span className="font-normal text-slate-500"> ({action.args.reason})</span>
        </>
      );
    case "zendesk.ticket.patchFields": {
      const { set, before } = action.args;
      const changes = (Object.keys(set) as (keyof typeof set)[]).map(
        (f) => `${f}: ${before[f] ?? "unset"} → ${set[f]}`,
      );
      return (
        <>
          Set {changes.join(", ")} on ticket <Code>#{action.args.ticketId}</Code>
        </>
      );
    }
    case "zendesk.ticket.appendPrivateNote": {
      const { template, bindings } = action.args;
      return (
        <>
          Private note on ticket <Code>#{action.args.ticketId}</Code>
          <span className="font-normal text-slate-500">
            {" "}
            from template {template.id} v{template.version}
            {Object.entries(bindings).map(([name, b]) => (
              <span key={name}>
                , {name} = {typeof b === "object" ? `result of ${b.stepId} (${b.path})` : String(b)}
              </span>
            ))}
          </span>
        </>
      );
    }
  }
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-slate-100 px-1 font-mono text-[0.85em]">{children}</code>;
}
