import type {
  Action,
  EntityRef,
  PlanManifest,
  Receipt,
  ReceiptOutcome,
} from "@rehearsal/contracts";
import type { CompensationContext, CompensationResult, Compensator } from "./executor";
import { undoKey } from "./executor";
import { sha256Hex } from "./hash";
import type { Clock, DispatchResult, Preconditions, ProviderPort, WorldContext } from "./ports";

type Patch = Extract<Action, { kind: "zendesk.ticket.patchFields" }>;
type Field = keyof Patch["args"]["set"];

export interface CompensatorDeps {
  providers: Partial<Record<"zendesk", ProviderPort>>;
  worlds: Partial<Record<"zendesk", WorldContext>>;
  clock: Clock;
}

const STAMP_LIMIT = "guarded by Zendesk's updated_stamp, which has a documented 1-second limit";

/**
 * A refusal no later run will send again: a 4xx other than 429. A throttle or a 5xx is not final.
 */
function definitelyRefused(receipt: Receipt | undefined): boolean {
  const status = receipt?.observedEffect.status;
  return (
    receipt?.outcome === "rejected" && typeof status === "number" && status < 500 && status !== 429
  );
}

/**
 * Patches to undo after this run: confirmed, conditionally reversible field patches in a case
 * where some step was definitely refused. Held or unknown steps are not failures, so their cases
 * are left alone. Refunds and notes are never compensated, and other cases are untouched.
 */
export function compensationTargets(
  manifest: PlanManifest,
  outcomes: ReadonlyMap<string, ReceiptOutcome>,
  receipts: readonly Receipt[],
): Patch[] {
  const latest = new Map(receipts.map((r) => [r.actionId, r]));
  const failed = new Set(
    manifest.actions
      .filter((a) => outcomes.get(a.id) === "rejected" && definitelyRefused(latest.get(a.id)))
      .map((a) => a.caseId),
  );
  const done = new Set(
    receipts
      .filter((r) => r.outcome === "compensated" || r.outcome === "compensation_conflict")
      .map((r) => r.actionId),
  );
  return manifest.actions.filter(
    (a): a is Patch =>
      a.kind === "zendesk.ticket.patchFields" &&
      a.compensation === "conditional_reversible" &&
      failed.has(a.caseId) &&
      outcomes.get(a.id) === "confirmed" &&
      !done.has(a.id),
  );
}

export interface UndoDecision {
  /** Fields still holding our value, mapped to the value observed before our write. */
  revert: Patch["args"]["set"];
  /** Fields someone else changed since our write, with their current value. Never written. */
  kept: Partial<Record<Field, unknown>>;
  /** Fields still ours whose before value can't be written back (e.g. an empty priority). */
  unrevertable: Field[];
}

/** Per written field: revert only if it still equals the exact value we wrote. */
export function decideUndo(action: Patch, current: Record<string, unknown>): UndoDecision {
  const decision: UndoDecision = { revert: {}, kept: {}, unrevertable: [] };
  for (const [field, written] of Object.entries(action.args.set) as [Field, string][]) {
    if (written === undefined) continue;
    if (current[field] !== written) {
      decision.kept[field] = current[field];
      continue;
    }
    const before = action.args.before[field];
    if (typeof before === "string") Object.assign(decision.revert, { [field]: before });
    else decision.unrevertable.push(field);
  }
  return decision;
}

/** The inverse typed patch: restore only the reverted fields, recording our value as "before". */
export function inversePatch(action: Patch, revert: UndoDecision["revert"]): Patch {
  const ours = Object.fromEntries(
    Object.keys(revert).map((f) => [f, action.args.set[f as Field]]),
  ) as Patch["args"]["before"];
  return { ...action, args: { ticketId: action.args.ticketId, set: revert, before: ours } };
}
const describe = (d: UndoDecision) => [
  ...Object.entries(d.revert).map(([f, v]) => `restored ${f} to ${String(v)}`),
  ...Object.entries(d.kept).map(([f, v]) => `kept ${f} = ${String(v)}: changed by someone else`),
  ...d.unrevertable.map((f) => `${f} still holds our value but its before value can't be written`),
];

/** Outcome once the reverted fields (if any) are back: a manual leftover wins over a conflict. */
function verdict(d: UndoDecision): Pick<CompensationResult, "outcome" | "holdReason"> {
  if (d.unrevertable.length > 0) {
    return {
      outcome: "held",
      holdReason: {
        kind: "unsupported_protection",
        detail: `undo ${d.unrevertable.join(", ")} by hand; the original value was empty`,
      },
    };
  }
  if (Object.keys(d.kept).length > 0) return { outcome: "compensation_conflict" };
  return { outcome: "compensated" };
}

/** A 409 means the ticket moved, not that our field did: re-read and decide again this often. */
const UNDO_ROUNDS = 3;

/**
 * Conditional compensation (T4). For each target patch: capture the ticket's stamp, re-read it,
 * and write back the before value only of fields that still hold ours, with a stamp-guarded patch
 * journaled before dispatch. A 409 re-reads and decides again, a bounded number of times. A
 * teammate's value is never overwritten; a lost undo response is held, never re-sent.
 */
export function createCompensator(deps: CompensatorDeps): Compensator {
  return async (ctx) => {
    for (const action of compensationTargets(ctx.manifest, ctx.outcomes, ctx.receipts)) {
      await compensate(action, ctx, deps);
    }
  };
}

async function compensate(action: Patch, ctx: CompensationContext, deps: CompensatorDeps) {
  const provider = deps.providers.zendesk;
  const world = deps.worlds.zendesk;
  const record = (r: CompensationResult) => ctx.record(action, r);
  const held = (detail: string) =>
    record({ outcome: "held", holdReason: { kind: "unsupported_protection", detail } });
  if (!provider || !world) return held("no Zendesk provider to compensate with");
  if (!provider.preconditions) return held("no stamp precondition to guard the undo with");

  const key = undoKey(ctx.orgId, ctx.manifest.planId, action);
  const earlier = (await ctx.journal.attemptsForKey(key)).at(-1);
  // A prepared row was never sent and a refused one wrote nothing, so a fresh round may follow.
  // The executor settles a patch with any other sent undo first; this only guards a re-send.
  if (earlier && earlier.state !== "prepared" && earlier.state !== "rejected") {
    return record({
      outcome: "held",
      holdReason: { kind: "unresolved_outcome", attemptId: earlier.id },
      observedEffect: { undoAttemptId: earlier.id },
      limitations: ["an earlier undo of this patch has no settled outcome; not re-sent"],
    });
  }

  const ticket: EntityRef = { vendor: "zendesk", kind: "ticket", id: action.args.ticketId };
  let attemptNo = earlier?.attemptNo ?? 0;
  for (let round = 1; ; round++) {
    let pre: Preconditions;
    let current: Record<string, unknown>;
    try {
      // Stamp first: an edit after this read makes the undo a 409 instead of overwriting it.
      pre = await provider.preconditions(action, world);
      current = (await provider.observe(ticket, world)).projection as Record<string, unknown>;
    } catch (err) {
      return record({
        outcome: "held",
        holdReason: {
          kind: "evidence_unavailable",
          evidenceId: action.evidence[0] ?? action.id,
          detail: `compensation re-read failed: ${(err as Error).message}`,
        },
      });
    }

    const decision = decideUndo(action, current);
    if (Object.keys(decision.revert).length === 0) {
      return record({
        ...verdict(decision),
        providerRef: ticket,
        observedEffect: { priority: current.priority, status: current.status },
        limitations: [...describe(decision), "nothing written"],
      });
    }
    if (!(await ctx.maySend())) {
      return record({
        outcome: "held",
        holdReason: {
          kind: "approval_invalid",
          detail: "run cancelled or approval no longer valid before the undo",
        },
        providerRef: ticket,
        observedEffect: { priority: current.priority, status: current.status },
        limitations: ["our value is still on the ticket; nothing written"],
      });
    }

    const inverse = inversePatch(action, decision.revert);
    const request = provider.prepare(inverse, new Map(), key, pre);
    const attemptId = ctx.newId("att");
    const now = () => deps.clock.now().toISOString();
    await ctx.journal.prepareAttempt({
      id: attemptId,
      actionId: action.id,
      planHash: ctx.planHash,
      operationKey: key,
      attemptNo: ++attemptNo,
      state: "prepared",
      request: {
        method: request.method,
        path: request.path,
        encoding: request.encoding,
        body: request.body,
        bodySha256: sha256Hex(request.body),
      },
      providerStatus: null,
      error: null,
      preparedAt: now(),
      dispatchedAt: null,
      settledAt: null,
    });
    await ctx.journal.transition(attemptId, "prepared", "dispatched", { dispatchedAt: now() });

    let result: DispatchResult;
    try {
      result = await provider.dispatch(request, world);
    } catch (err) {
      result = { kind: "unknown", error: (err as Error).message };
    }

    if (result.kind === "confirmed") {
      const body = (result.body as { ticket?: Record<string, unknown> } | null)?.ticket;
      const restored =
        body !== undefined &&
        Object.entries(decision.revert).every(([field, value]) => body[field] === value);
      if (restored) {
        return record({
          ...verdict(decision),
          providerRef: ticket,
          observedEffect: {
            priority: body.priority,
            status: body.status,
            updated_at: body.updated_at,
          },
          limitations: [...describe(decision), STAMP_LIMIT],
          transition: {
            attemptId,
            from: "dispatched",
            to: "confirmed",
            patch: { providerStatus: result.status, settledAt: now() },
          },
        });
      }
      result = { kind: "unknown", error: "undo response does not show the restored values" };
    }

    if (result.kind === "rejected") {
      const transition = {
        attemptId,
        from: "dispatched" as const,
        to: "rejected" as const,
        patch: {
          providerStatus: result.status,
          error: JSON.stringify(result.body).slice(0, 500),
          settledAt: now(),
        },
      };
      if (result.status === 409 && round < UNDO_ROUNDS) {
        // The ticket moved after our re-read; whether our field did is for the next re-read to say.
        await ctx.journal.transition(attemptId, "dispatched", "rejected", transition.patch);
        continue;
      }
      if (result.status === 409) {
        return record({
          outcome: "held",
          holdReason: {
            kind: "unsupported_protection",
            detail: `ticket kept changing during the undo (${UNDO_ROUNDS} × 409); our value was still there at the last re-read`,
          },
          providerRef: ticket,
          observedEffect: { status: 409 },
          limitations: ["nothing written"],
          transition,
        });
      }
      return record({
        outcome: "held",
        holdReason: {
          kind: "unsupported_protection",
          detail: `undo refused with ${result.status}; nothing written`,
        },
        transition,
      });
    }

    return record({
      outcome: "held",
      holdReason: { kind: "unresolved_outcome", attemptId },
      limitations: ["undo response lost; reconcile through a read, never re-send"],
      transition: {
        attemptId,
        from: "dispatched",
        to: "unknown_outcome",
        patch: { error: result.error },
      },
    });
  }
}
