import type {
  Action,
  Attempt,
  EntityRef,
  PlanManifest,
  Receipt,
  ReceiptOutcome,
} from "@rehearsal/contracts";
import { topoOrder } from "./dag";
import type { CompensationContext, CompensationResult, Compensator } from "./executor";
import { operationKey, undoKey } from "./executor";
import { sha256Hex } from "./hash";
import type { Clock, DispatchResult, Preconditions, ProviderPort, WorldContext } from "./ports";
import { operationMarker } from "./templates";

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
      .filter((a) => {
        const outcome = outcomes.get(a.id);
        if (
          outcome === "confirmed" ||
          outcome === "compensated" ||
          outcome === "compensation_conflict"
        ) {
          return false;
        }
        if (outcome === "rejected" && definitelyRefused(latest.get(a.id))) return true;
        // This run skipped or held the step, but an earlier receipt on this hash was a real refusal.
        return receipts.some((r) => r.actionId === a.id && definitelyRefused(r));
      })
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

/** The guarded patch plus the undo's operation marker, so a later read can attribute it. */
function undoBody(body: string, operationKey: string): string {
  const parsed = JSON.parse(body) as { ticket: Record<string, unknown> };
  parsed.ticket.comment = { body: operationMarker(operationKey), public: false };
  return JSON.stringify(parsed);
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
 * teammate's value is never overwritten. A lost undo response is held; a later run reads the ticket
 * and records it, or sends a fresh undo once a read shows it never landed.
 */
/** A held patch in a case that still failed, so an in-flight undo can be read or sent again. */
function heldUndoTargets(
  manifest: PlanManifest,
  outcomes: ReadonlyMap<string, ReceiptOutcome>,
  receipts: readonly Receipt[],
): Patch[] {
  const failed = new Set(compensationTargets(manifest, outcomes, receipts).map((a) => a.caseId));
  // The patch itself may be held, so it is not a target, but its case still failed.
  for (const action of manifest.actions) {
    if (outcomes.get(action.id) === "rejected") {
      const receipt = receipts.filter((r) => r.actionId === action.id).at(-1);
      if (definitelyRefused(receipt)) failed.add(action.caseId);
    }
    if (
      outcomes.get(action.id) !== "confirmed" &&
      outcomes.get(action.id) !== "compensated" &&
      outcomes.get(action.id) !== "compensation_conflict" &&
      receipts.some((r) => r.actionId === action.id && definitelyRefused(r))
    ) {
      failed.add(action.caseId);
    }
  }
  const done = new Set(compensationTargets(manifest, outcomes, receipts).map((a) => a.id));
  return manifest.actions.filter(
    (a): a is Patch =>
      a.kind === "zendesk.ticket.patchFields" &&
      a.compensation === "conditional_reversible" &&
      failed.has(a.caseId) &&
      outcomes.get(a.id) === "held" &&
      receipts.filter((r) => r.actionId === a.id).at(-1)?.holdReason?.kind ===
        "unresolved_outcome" &&
      !done.has(a.id),
  );
}

/**
 * Later writes first. Undoing an earlier patch while a later one still holds the field makes that
 * later value look like a teammate edit, so a chain (normal → high → urgent) would stop at high.
 */
function compensationOrder(manifest: PlanManifest, actions: readonly Patch[]): Patch[] {
  const wanted = new Set(actions.map((a) => a.id));
  return topoOrder(manifest.actions)
    .filter((a): a is Patch => wanted.has(a.id))
    .reverse();
}

function writtenFields(action: Patch): Field[] {
  return (Object.entries(action.args.set) as [Field, string | undefined][])
    .filter(([, value]) => value !== undefined)
    .map(([field]) => field);
}

/** Later patches that wrote one of `action`'s fields on the same ticket, latest last. */
function laterOverlapping(manifest: PlanManifest, action: Patch): Patch[] {
  const order = topoOrder(manifest.actions);
  const start = order.findIndex((item) => item.id === action.id);
  const mine = new Set(writtenFields(action));
  return order.slice(start + 1).filter((item): item is Patch => {
    if (item.kind !== "zendesk.ticket.patchFields" || item.args.ticketId !== action.args.ticketId) {
      return false;
    }
    return writtenFields(item).some((field) => mine.has(field));
  });
}

/** Fields this undo request wrote back to the patch's before value. */
function undoRestoredFields(attempt: Attempt, action: Patch): Set<Field> {
  let ticket: Record<string, unknown>;
  try {
    ticket =
      (JSON.parse(attempt.request.body) as { ticket?: Record<string, unknown> }).ticket ?? {};
  } catch {
    return new Set();
  }
  const restored = new Set<Field>();
  for (const field of writtenFields(action)) {
    const before = action.args.before[field];
    if (typeof before === "string" && ticket[field] === before) restored.add(field);
  }
  return restored;
}

/** Restoration proof from an undo that has already settled, not from receipt prose. */
function restoredByUndo(attempt: Attempt | undefined, action: Patch): Set<Field> {
  if (!attempt || (attempt.state !== "confirmed" && attempt.state !== "reconciled"))
    return new Set();
  return undoRestoredFields(attempt, action);
}

/**
 * One shared field of a later patch. `wait`: a sent undo has not settled. A hold with no
 * dispatched attempt is not an undo. `keep`: this field was not restored, so a matching value is
 * not our older write. `clear`: this field was restored, or the later patch never wrote.
 */
function fieldUndoGate(
  receipt: Receipt | undefined,
  field: Field,
  restored: boolean,
  sent: boolean,
): "wait" | "keep" | "clear" {
  if (receipt?.outcome === "unknown_outcome") return "wait";
  if (receipt?.outcome === "held") return sent ? "wait" : "clear";
  if (
    !receipt ||
    receipt.outcome === "rejected" ||
    receipt.outcome === "skipped_dependency" ||
    receipt.outcome === "compensated" ||
    restored ||
    receipt.limitations.some((line) => line.startsWith(`restored ${field} `))
  ) {
    return "clear";
  }
  // Confirmed: a later write we are not undoing. Conflict without a restored field: not ours.
  return "keep";
}

export function createCompensator(deps: CompensatorDeps): Compensator {
  return async (ctx) => {
    const actions = compensationOrder(ctx.manifest, [
      ...compensationTargets(ctx.manifest, ctx.outcomes, ctx.receipts),
      ...heldUndoTargets(ctx.manifest, ctx.outcomes, ctx.receipts),
    ]);
    const latest = new Map<string, Receipt>();
    for (const receipt of await ctx.journal.receiptsFor(ctx.planHash)) {
      latest.set(receipt.actionId, receipt);
    }
    for (const action of actions) {
      const blocked = new Set<Field>();
      let wait = false;
      for (const other of laterOverlapping(ctx.manifest, action)) {
        const receipt = latest.get(other.id);
        const shared = writtenFields(action).filter((field) =>
          writtenFields(other).includes(field),
        );
        const [undos, forwards] = await Promise.all([
          ctx.journal.attemptsForKey(undoKey(ctx.orgId, ctx.manifest.planId, other)),
          ctx.journal.attemptsForKey(operationKey(ctx.orgId, ctx.manifest.planId, other)),
        ]);
        const sent = [...undos, ...forwards].some((item) => item.state !== "prepared");
        const restored = restoredByUndo(
          undos.filter((item) => item.state === "confirmed" || item.state === "reconciled").at(-1),
          other,
        );
        for (const field of shared) {
          const gate = fieldUndoGate(receipt, field, restored.has(field), sent);
          if (gate === "wait") wait = true;
          else if (gate === "keep") blocked.add(field);
        }
      }
      if (wait) continue;
      await compensate(action, ctx, deps, blocked);
      const recorded = (await ctx.journal.receiptsFor(ctx.planHash))
        .filter((receipt) => receipt.actionId === action.id)
        .at(-1);
      if (recorded) latest.set(action.id, recorded);
    }
  };
}

/** Whether an in-flight undo's own fields, and its private marker, are on the ticket. */
async function undoRead(
  provider: ProviderPort,
  world: WorldContext,
  action: Patch,
  attempt: Attempt,
): Promise<"landed" | "absent" | "unknown"> {
  let sent: Patch["args"]["set"];
  try {
    const ticket =
      (JSON.parse(attempt.request.body) as { ticket?: Record<string, unknown> }).ticket ?? {};
    sent = {};
    if (typeof ticket.priority === "string")
      sent.priority = ticket.priority as typeof sent.priority;
    if (typeof ticket.status === "string") sent.status = ticket.status as typeof sent.status;
    if (sent.priority === undefined && sent.status === undefined) return "unknown";
  } catch {
    return "unknown";
  }
  try {
    const fields = await provider.reconcile(
      attempt,
      { ...action, args: { ...action.args, set: sent } },
      world,
    );
    if (fields.kind === "not_applied") return "absent";
    if (fields.kind !== "applied") return "unknown";
    const marked = await provider.reconcile(
      attempt,
      {
        ...action,
        kind: "zendesk.ticket.appendPrivateNote",
        args: {
          ticketId: action.args.ticketId,
          public: false,
          template: { id: "refund-confirmed", version: 1 },
          bindings: {},
        },
      },
      world,
    );
    return marked.kind === "applied" ? "landed" : "unknown";
  } catch {
    return "unknown";
  }
}

async function compensate(
  action: Patch,
  ctx: CompensationContext,
  deps: CompensatorDeps,
  /** Fields a later patch wrote and did not restore. Matching them is not proof they are still ours. */
  blocked: ReadonlySet<Field> = new Set(),
) {
  const provider = deps.providers.zendesk;
  const world = deps.worlds.zendesk;
  const record = (r: CompensationResult) => ctx.record(action, r);
  const held = (detail: string) =>
    record({ outcome: "held", holdReason: { kind: "unsupported_protection", detail } });
  if (!provider || !world) return held("no Zendesk provider to compensate with");
  if (!provider.preconditions) return held("no stamp precondition to guard the undo with");

  const key = undoKey(ctx.orgId, ctx.manifest.planId, action);
  const earlier = (await ctx.journal.attemptsForKey(key)).at(-1);
  // Close this in-flight undo only after a fresh one is actually dispatched.
  // `reject` — a negative read showed it never landed. `reconcile` — it landed, but a field remains.
  let closeEarlier: "reject" | "reconcile" | null = null;
  // A prepared row was never sent and a refused one wrote nothing, so a fresh round may follow.
  // An in-flight undo is read here: restored values are recorded, and a negative read sends a
  // fresh undo only once it is old enough. Dependents never see the patch as confirmed meanwhile.
  if (earlier && earlier.state !== "prepared" && earlier.state !== "rejected") {
    const open = earlier.state === "unknown_outcome" || earlier.state === "dispatched";
    // Confirmed or reconciled already: the executor recorded what that undo means.
    if (!open) return;
    const sentAt = Date.parse(earlier.dispatchedAt ?? earlier.preparedAt);
    const oldEnough = deps.clock.now().getTime() - sentAt >= (ctx.reconcileAfterMs ?? 60_000);
    const read = await undoRead(provider, world, action, earlier);
    if (read === "landed") {
      const current = (
        await provider
          .observe({ vendor: "zendesk", kind: "ticket", id: action.args.ticketId }, world)
          .catch(() => null)
      )?.projection as Record<string, unknown> | undefined;
      const still = current
        ? Object.entries(action.args.set).filter(
            ([field, written]) =>
              written !== undefined &&
              current[field] === written &&
              typeof action.args.before[field as Field] === "string",
          )
        : [];
      if (current && still.length === 0) {
        const changed = Object.entries(action.args.set).filter(([field, written]) => {
          if (written === undefined || current[field] === written) return false;
          return current[field] !== action.args.before[field as Field];
        });
        if (earlier.state === "dispatched") {
          await ctx.journal.transition(earlier.id, "dispatched", "unknown_outcome", {
            error: "outcome unknown",
          });
        }
        const settledAt = deps.clock.now().toISOString();
        const transition = {
          attemptId: earlier.id,
          from: "unknown_outcome" as const,
          to: "reconciled" as const,
          patch: { settledAt },
        };
        if (changed.length > 0) {
          return record({
            outcome: "compensation_conflict",
            providerRef: { vendor: "zendesk", kind: "ticket", id: action.args.ticketId },
            observedEffect: { priority: current.priority, status: current.status },
            limitations: [
              ...[...undoRestoredFields(earlier, action)].map(
                (field) => `restored ${field} to ${String(action.args.before[field])}`,
              ),
              ...changed.map(
                ([field]) => `kept ${field} = ${String(current[field])}: changed by someone else`,
              ),
            ],
            transition,
          });
        }
        return record({
          outcome: "compensated",
          providerRef: { vendor: "zendesk", kind: "ticket", id: action.args.ticketId },
          observedEffect: { priority: current.priority, status: current.status },
          limitations: [
            `outcome of undo attempt ${earlier.id} found by reading the provider; not re-sent`,
          ],
          transition,
        });
      }
      // A field still holds our value. Reconcile this undo only once the follow-up is dispatched.
      if (current) closeEarlier = "reconcile";
    } else if (read === "absent" && oldEnough && (await ctx.maySend())) {
      closeEarlier = "reject";
    } else {
      const already = ctx.receipts.some(
        (r) =>
          r.actionId === action.id &&
          r.outcome === "held" &&
          r.holdReason?.kind === "unresolved_outcome" &&
          r.holdReason.attemptId === earlier.id,
      );
      if (already) return;
      return record({
        outcome: "held",
        holdReason: { kind: "unresolved_outcome", attemptId: earlier.id },
        observedEffect: { undoAttemptId: earlier.id },
        limitations: ["an earlier undo of this patch has no settled outcome; not re-sent"],
      });
    }
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
    // A field this undo already restored is not a conflict. A teammate restoring the same value
    // leaves no marker, and a field this undo never sent stays a conflict.
    if (earlier && (await undoRead(provider, world, action, earlier)) === "landed") {
      let sent: Set<string>;
      try {
        const ticket =
          (JSON.parse(earlier.request.body) as { ticket?: Record<string, unknown> }).ticket ?? {};
        sent = new Set(
          (["priority", "status"] as const).filter((field) => typeof ticket[field] === "string"),
        );
      } catch {
        sent = new Set();
      }
      for (const field of Object.keys(decision.kept) as Field[]) {
        if (sent.has(field) && current[field] === action.args.before[field]) {
          delete decision.kept[field];
        }
      }
    }
    for (const field of blocked) {
      if (decision.revert[field] === undefined && !decision.unrevertable.includes(field)) continue;
      decision.kept[field] = current[field];
      delete decision.revert[field];
      decision.unrevertable = decision.unrevertable.filter((item) => item !== field);
    }
    if (Object.keys(decision.revert).length === 0) {
      // A late landing of our own undo restores the before value and then 409s the fresh send.
      // The marker says it was ours; a teammate restoring the same value leaves no marker.
      // Fields that marker restored were taken out of `kept` above. A field it never restored
      // is still a conflict or a manual hold, not proof the whole patch was undone.
      if (earlier && (await undoRead(provider, world, action, earlier)) === "landed") {
        const settled = verdict(decision);
        const late = "our earlier undo landed; nothing further written";
        return record({
          ...settled,
          providerRef: ticket,
          observedEffect: { priority: current.priority, status: current.status },
          limitations: settled.outcome === "compensated" ? [late] : [...describe(decision), late],
        });
      }
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
    const prepared = provider.prepare(inverse, new Map(), key, pre);
    // A private marker distinguishes our undo from someone else restoring the same value.
    const request = { ...prepared, body: undoBody(prepared.body, key) };
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
    if (closeEarlier && earlier) {
      if (earlier.state === "dispatched") {
        await ctx.journal.transition(earlier.id, "dispatched", "unknown_outcome", {
          error: "outcome unknown",
        });
      }
      if (earlier.state === "dispatched" || earlier.state === "unknown_outcome") {
        await ctx.journal.transition(
          earlier.id,
          "unknown_outcome",
          closeEarlier === "reject" ? "rejected" : "reconciled",
          closeEarlier === "reject"
            ? {
                providerStatus: null,
                error: "undo not visible; a fresh undo is permitted",
                settledAt: now(),
              }
            : { settledAt: now() },
        );
      }
      closeEarlier = null;
    }

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
