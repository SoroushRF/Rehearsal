import {
  type HoldReason,
  Receipt,
  type ReceiptOutcome,
  RunEvent,
  RunState,
  Sha256Hex,
} from "@rehearsal/contracts";
import { z } from "zod";

export const RunView = z.object({
  id: z.string(),
  planId: z.string(),
  revision: z.int(),
  planHash: Sha256Hex,
  approvalId: z.string(),
  requestedBy: z.string(),
  state: RunState,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RunView = z.infer<typeof RunView>;

export const RunEvents = z.object({ run: RunView, events: z.array(RunEvent), more: z.boolean() });

/** A run in one of these states won't write more events, so polling can stop. */
export const FINISHED: readonly RunState[] = [
  "completed",
  "partial",
  "held",
  "failed",
  "cancelled",
];

/** The latest receipt per action; a later run's receipt for the same action replaces an earlier one. */
export function latestReceipts(events: readonly RunEvent[]): Map<string, Receipt> {
  const byAction = new Map<string, Receipt>();
  for (const e of events) {
    if (e.type !== "step.receipt") continue;
    const r = Receipt.safeParse(e.payload);
    if (r.success) byAction.set(r.data.actionId, r.data);
  }
  return byAction;
}

export const outcomeLabel: Record<ReceiptOutcome, string> = {
  confirmed: "Done",
  rejected: "Refused",
  held: "Held",
  unknown_outcome: "Outcome unknown",
  skipped_dependency: "Skipped",
  compensated: "Undone",
  compensation_conflict: "Kept teammate's edit",
};

/** Why a step was held, in words a reviewer who wasn't there can follow. */
export function explainHold(h: HoldReason): string {
  switch (h.kind) {
    case "query_membership_changed":
      return h.added.length > 0
        ? `New matching record${h.added.length === 1 ? "" : "s"} appeared after approval (${h.added.join(", ")}). The approved plan didn't account for ${h.added.length === 1 ? "it" : "them"}, so this step waits for a new plan.`
        : `Record${h.removed.length === 1 ? "" : "s"} the plan relied on no longer match (${h.removed.join(", ")}).`;
    case "row_changed":
      return `${h.fields.join(", ")} changed on the record since approval (${h.observationId}). Applying now would act on stale facts.`;
    case "approval_invalid":
      return `The approval no longer holds: ${h.detail}.`;
    case "predecessor_not_confirmed":
      return `Waits for ${h.stepId}, which didn't complete.`;
    case "policy_violation":
      return `Breaks policy ${h.rule}: ${h.detail}.`;
    case "unsupported_protection":
      return `The provider can't protect this write: ${h.detail}.`;
    case "unresolved_outcome":
      return `An earlier send (${h.attemptId}) has an unknown outcome; it is reconciled through reads, never re-sent blindly.`;
    case "evidence_unavailable":
      return `Couldn't re-check ${h.evidenceId}: ${h.detail}. Missing evidence is never treated as "nothing changed".`;
  }
}

/** One line per receipt: what happened to this step and why. */
export function explainReceipt(r: Receipt): string {
  switch (r.outcome) {
    // How the effect was confirmed (write response or a read) is in the receipt's limitations.
    case "confirmed":
      return r.providerRef ? `Applied (${r.providerRef.kind} ${r.providerRef.id}).` : "Applied.";
    case "held":
      return r.holdReason ? explainHold(r.holdReason) : "Held before sending.";
    case "skipped_dependency":
      return r.holdReason
        ? explainHold(r.holdReason)
        : "Skipped because a step it depends on didn't complete.";
    case "unknown_outcome":
      return "The provider's response was lost. The step is reconciled through reads and never re-sent blindly.";
    case "rejected":
      return "The provider refused the write; nothing changed.";
    case "compensated":
      return "Undone: the field still held the value we wrote, so it was restored.";
    case "compensation_conflict":
      return "Not undone: someone changed the field after we wrote it, so their edit was kept.";
  }
}

/** The run log as sentences. Unknown event types still show, with their raw type. */
export function describeEvent(e: RunEvent): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case "run.admitted":
      return `Admitted: approval ${String(p.approvalId)} is live for this exact hash.`;
    case "run.reconciling":
      return "Reading back earlier sends whose outcome is unknown. Nothing new is sent.";
    case "run.refused":
      return `Refused before any step: ${String(p.detail)}.`;
    case "run.deferred":
      return `Waiting: ${String(p.detail)}.`;
    case "step.retry":
      return `${String(p.actionId)}: provider answered ${String(p.status)}; sending the same bytes again in ${String(p.delayMs)} ms.`;
    case "step.reconcile":
      return `${String(p.actionId)}: reconciling an unknown outcome through reads.`;
    case "run.reaped":
      return "Re-queued: the run had stalled with no job running, so it was picked up again.";
    case "run.needs_operator":
      return "Stuck: automatic retries are exhausted. An operator needs to look at this run.";
    case "step.error":
      return `${String(p.actionId)}: stopped on an unexpected error (${String(p.error)}).`;
    case "step.receipt": {
      const r = Receipt.safeParse(e.payload);
      return r.success
        ? `${r.data.actionId}: ${outcomeLabel[r.data.outcome]}. ${explainReceipt(r.data)}`
        : "Receipt recorded.";
    }
    case "run.finished":
      return `Run finished: ${String(p.state)}${p.error ? ` (${String(p.error)})` : ""}.`;
    case "run.stopped":
      if (p.unresolved && !p.error) {
        return "An earlier send can't be read back yet. It is read again automatically until retries run out, then handed to an operator. Nothing new is sent.";
      }
      return `Stopped on an unexpected error (${String(p.error)}). It is retried automatically until retries run out, then handed to an operator.`;
    default:
      return e.type;
  }
}
