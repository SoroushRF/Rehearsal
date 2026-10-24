import type { Action, CompensationClass, ProtectionLevel } from "@rehearsal/contracts";
import { compensationLabel, formatMoney, protectionLabel, roleLabel } from "../format";
import { Chip, Icon, type IconName, type Tone } from "./ui";

/** Which effect this is, as a colored tile: money moves, a field changes, or a note is added. */
const KIND: Record<Action["kind"], { icon: IconName; tile: string; label: string }> = {
  "stripe.refund.create": { icon: "refund", tile: "bg-accent-soft text-accent", label: "Refund" },
  "zendesk.ticket.patchFields": { icon: "edit", tile: "bg-info-bg text-info", label: "Ticket" },
  "zendesk.ticket.appendPrivateNote": { icon: "note", tile: "bg-sunken text-muted", label: "Note" },
};

const compensationTone: Record<CompensationClass, { tone: Tone; icon: IconName }> = {
  conditional_reversible: { tone: "good", icon: "undo" },
  compensable_by_new_action: { tone: "warn", icon: "refund" },
  irreversible: { tone: "danger", icon: "lock" },
};

const protectionTone: Record<ProtectionLevel, Tone> = {
  native_guard_with_documented_limits: "neutral",
  best_effort_reread: "warn",
  no_atomic_guard: "warn",
};

/** Present only when the reviewer can uncheck actions (a live plan, not a fixture). */
export interface IncludeControl {
  /** The reviewer unchecked this action. */
  unchecked: boolean;
  /** Dropped because something it depends on was unchecked. */
  droppedWithDependency: boolean;
  onToggle: () => void;
}

const reasonLabel = { duplicate: "Duplicate charge", requested_by_customer: "Customer request" };

export function ActionRow({
  action,
  selected,
  onShowEvidence,
  include,
  dependsOnLabels = [],
}: {
  action: Action;
  selected: boolean;
  onShowEvidence: () => void;
  include?: IncludeControl;
  /** Short names of the steps this one waits for. */
  dependsOnLabels?: string[];
}) {
  const kind = KIND[action.kind];
  const comp = compensationLabel[action.compensation];
  const prot = protectionLabel[action.protection];
  const dropped = include && (include.unchecked || include.droppedWithDependency);
  const evidenceCount = action.evidence.length + action.queryEvidence.length;

  return (
    <li
      data-testid="action-row"
      data-action-id={action.id}
      data-dropped={dropped ? "true" : undefined}
      className={`group relative flex gap-2.5 px-3 py-4 transition-colors sm:gap-4 sm:px-5 ${
        selected ? "bg-accent-soft/60" : dropped ? "bg-sunken/70" : "hover:bg-sunken/50"
      }`}
    >
      {include && (
        <input
          type="checkbox"
          aria-label={`Include ${action.id}`}
          checked={!dropped}
          // A dependent can't be re-included on its own; re-check what it depends on instead.
          disabled={include.droppedWithDependency && !include.unchecked}
          onChange={include.onToggle}
          className="mt-2.5 h-[18px] w-[18px] shrink-0 cursor-pointer accent-[var(--accent)] disabled:cursor-not-allowed"
        />
      )}

      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg sm:h-10 sm:w-10 sm:rounded-xl ${kind.tile} ${dropped ? "opacity-50" : ""}`}
        title={kind.label}
      >
        <Icon name={kind.icon} className="h-4 w-4 sm:h-5 sm:w-5" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h4
              className={`flex flex-wrap items-baseline gap-x-2 text-[15px] leading-6 font-semibold text-ink ${dropped ? "line-through decoration-subtle/60" : ""}`}
            >
              <span>
                <Title action={action} />
              </span>
              <code className="font-mono text-[11px] font-normal text-subtle">{action.id}</code>
            </h4>
            <Detail action={action} />
          </div>

          {action.kind === "stripe.refund.create" && (
            <p className="tnum shrink-0 text-right text-base leading-6 font-semibold text-ink">
              {formatMoney(action.args.amount)}
            </p>
          )}
        </div>

        <p className="mt-1 text-sm leading-5 text-muted">{action.rationale}</p>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Chip
              tone={compensationTone[action.compensation].tone}
              icon={compensationTone[action.compensation].icon}
              hint={comp.hint}
            >
              {comp.text}
            </Chip>
            <Chip tone={protectionTone[action.protection]} icon="shield" hint={prot.hint}>
              {prot.text}
            </Chip>
            <Chip
              tone={action.requiredRole === "finance_lead" ? "info" : "neutral"}
              icon="users"
              hint="Role that must approve this step"
            >
              {roleLabel[action.requiredRole]}
            </Chip>
            {dependsOnLabels.length > 0 && (
              <Chip
                tone="accent"
                icon="arrow"
                hint="This step only runs once the step it follows has been confirmed"
              >
                After {dependsOnLabels.join(", ")}
              </Chip>
            )}
            {dropped && <Chip tone="neutral">Won't run</Chip>}
          </div>
          <button
            type="button"
            onClick={onShowEvidence}
            aria-pressed={selected}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-2.5 text-[13px] font-medium text-ink shadow-card hover:bg-sunken"
          >
            <Icon name="eye" className="h-3.5 w-3.5 text-subtle" />
            Evidence
            <span className="tnum rounded-full bg-sunken px-1.5 text-xs leading-5 text-muted">
              {evidenceCount}
            </span>
          </button>
        </div>
      </div>
    </li>
  );
}

function Title({ action }: { action: Action }) {
  switch (action.kind) {
    case "stripe.refund.create":
      return <>Refund the customer</>;
    case "zendesk.ticket.patchFields":
      return (
        <>
          Update ticket <Ref>#{action.args.ticketId}</Ref>
        </>
      );
    case "zendesk.ticket.appendPrivateNote":
      return (
        <>
          Add a private note to ticket <Ref>#{action.args.ticketId}</Ref>
        </>
      );
  }
}

/** The one line of specifics under the title, in words, with no field paths or template syntax. */
function Detail({ action }: { action: Action }) {
  const line = "flex flex-wrap gap-x-2 text-[13px] leading-5 text-subtle";
  switch (action.kind) {
    case "stripe.refund.create":
      return (
        <p className={line}>
          <span className="whitespace-nowrap">
            Charge <Mono>{action.args.chargeId}</Mono>
          </span>
          <span className="whitespace-nowrap">· {reasonLabel[action.args.reason]}</span>
        </p>
      );
    case "zendesk.ticket.patchFields": {
      const { set, before } = action.args;
      const fields = (Object.keys(set) as (keyof typeof set)[]).map((f) => (
        <span key={f} className="whitespace-nowrap">
          {f[0]?.toUpperCase()}
          {f.slice(1)} {before[f] ?? "unset"}{" "}
          <Icon name="arrow" className="inline h-3 w-3 align-[-1px]" /> {set[f]}
        </span>
      ));
      return <p className={`${line} gap-x-3`}>{fields}</p>;
    }
    case "zendesk.ticket.appendPrivateNote": {
      const refs = Object.values(action.args.bindings).flatMap((b) =>
        typeof b === "object" ? [b.stepId] : [],
      );
      return (
        <p className={line}>
          <span className="whitespace-nowrap">
            Template <Mono>{action.args.template.id}</Mono> v{action.args.template.version}
          </span>
          {refs.length > 0 && (
            <span className="whitespace-nowrap">· cites the result of {refs.join(", ")}</span>
          )}
        </p>
      );
    }
  }
}

const Ref = ({ children }: { children: React.ReactNode }) => (
  <span className="tnum rounded-md bg-sunken px-1.5 py-0.5 font-mono text-[13px] font-medium">
    {children}
  </span>
);
const Mono = ({ children }: { children: React.ReactNode }) => (
  <code className="font-mono text-[12px] text-muted">{children}</code>
);
