import type { Action, PlanManifest, Receipt, Role } from "@rehearsal/contracts";
import {
  type BillingPolicyV1,
  bindingKey,
  createReadGuard,
  type DispatchResult,
  executeRun,
  type ProviderPort,
  planHash,
} from "@rehearsal/core";
import { FakeClock, MemoryApplyStore, MemoryJournal } from "@rehearsal/testkit";
import type { EraVendor } from "../../providers/src/harness";
import type { DecidedIntent, Intent } from "./agent";

/**
 * The three ways of applying the same agent decisions to an operational world.
 *
 * - direct: every intent is sent as soon as it's made, through the same typed writers the executor
 *   uses (same idempotency keys on refunds, same guarded Zendesk update). No plan, no review, no
 *   guard. Like an SDK client, it re-sends the same bytes once after a 429 or a lost response.
 * - per_call: direct, but a reviewer is asked before every call. The reviewer is modelled as
 *   diligent: they reject exactly the calls the planning tools' policy checks reject, and pass the
 *   rest. They see the call, not later changes in the world.
 * - rehearsal: the accepted intents are the plan; one approval per signing role; the executor
 *   applies it with the read guard, and is restarted to reconcile anything left unknown.
 */

export interface ApplyResult {
  unresolved: number;
  reviewerActions: number;
  promptOpportunities: number;
  /** Per-step notes for the results file (receipts, refusals, send results). */
  log: string[];
}

type Ports = Record<EraVendor, ProviderPort>;
type Contexts = Record<EraVendor, { world: "operational"; tenant: string }>;

/** Direct and per-call: send each intent as a typed write, in the order the agent made them. */
export async function applyCalls(
  decided: readonly DecidedIntent[],
  ports: Ports,
  ctx: Contexts,
  opts: { taskId: string; review: boolean },
): Promise<ApplyResult> {
  const refundIds = new Map<string, string>();
  const log: string[] = [];
  let unresolved = 0;
  let prompts = 0;
  for (const [n, { intent, accepted, refusal }] of decided.entries()) {
    const label = `${intent.tool} ${JSON.stringify(intent.input)}`;
    if (opts.review) {
      prompts++;
      if (!accepted) {
        log.push(`rejected by reviewer: ${label} (${refusal})`);
        continue;
      }
    }
    const action = actionFor(intent);
    const vendor: EraVendor = action.kind === "stripe.refund.create" ? "stripe" : "zendesk";
    const port = ports[vendor];
    const bindings = new Map<string, string | number>();
    if (action.kind === "zendesk.ticket.appendPrivateNote") {
      const refundStepId = intent.tool === "propose_refund_note" ? intent.input.refundStepId : "";
      const refundId = refundIds.get(refundStepId);
      if (!refundId) {
        log.push(`skipped (its refund didn't go through): ${label}`);
        continue;
      }
      bindings.set(bindingKey({ stepId: refundStepId, path: "refund.id" }), refundId);
    }
    try {
      const pre = (await port.preconditions?.(action, ctx[vendor])) ?? {};
      // A fresh key per call: a separate tool call is a separate request.
      const req = port.prepare(action, bindings, `op_direct_${opts.taskId}_${n}`, pre);
      let result: DispatchResult = await port.dispatch(req, ctx[vendor]);
      if (result.kind === "unknown" || (result.kind === "rejected" && result.retryable)) {
        if (result.kind === "rejected") await sleep(result.retryAfterMs ?? 1000);
        result = await port.dispatch(req, ctx[vendor]);
      }
      log.push(`${describe(result)}: ${label}`);
      if (result.kind === "unknown") unresolved++;
      if (result.kind === "confirmed" && action.kind === "stripe.refund.create") {
        const body = result.body as { id?: unknown };
        if (typeof body.id === "string") refundIds.set(action.id, body.id);
      }
    } catch (e) {
      log.push(`failed before sending (${(e as Error).message}): ${label}`);
    }
  }
  return { unresolved, reviewerActions: prompts, promptOpportunities: prompts, log };
}

function describe(r: DispatchResult): string {
  if (r.kind === "unknown") return "unknown";
  return `${r.kind} ${r.status}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The action an intent describes, built from the agent's own reads without any checks: what a
 * direct tool call would carry. Same IDs and shapes as the planning tools produce.
 */
function actionFor(intent: Intent): Action {
  const common = {
    caseId: `case_${intent.caseKey}`,
    obligationId: `obl_${intent.caseKey}`,
    requiredRole: "support_lead" as Role,
    evidence: [],
    queryEvidence: [],
  };
  switch (intent.tool) {
    case "propose_duplicate_refund":
      return {
        ...common,
        id: `refund_${intent.input.chargeId}`,
        kind: "stripe.refund.create",
        dependsOn: [],
        compensation: "compensable_by_new_action",
        protection: "native_guard_with_documented_limits",
        rationale: intent.input.rationale,
        args: {
          chargeId: intent.input.chargeId,
          amount: { amountMinor: intent.amountMinor, currency: intent.currency },
          reason: "duplicate",
        },
      } as Action;
    case "propose_ticket_priority":
      return {
        ...common,
        id: `patch_${intent.input.ticketId}`,
        kind: "zendesk.ticket.patchFields",
        dependsOn: [],
        compensation: "conditional_reversible",
        protection: "native_guard_with_documented_limits",
        rationale: intent.input.rationale,
        args: {
          ticketId: intent.input.ticketId,
          set: { priority: intent.input.priority },
          before: intent.before,
        },
      } as Action;
    case "propose_refund_note":
      return {
        ...common,
        id: `note_${intent.input.refundStepId}`,
        kind: "zendesk.ticket.appendPrivateNote",
        dependsOn: [intent.input.refundStepId],
        compensation: "irreversible",
        protection: "no_atomic_guard",
        rationale: `Record ${intent.input.refundStepId}.`,
        args: {
          ticketId: intent.input.ticketId,
          public: false,
          template: { id: "refund-confirmed", version: 1 },
          bindings: {
            refundId: { $ref: "result", stepId: intent.input.refundStepId, path: "refund.id" },
            amountMinor: intent.amountMinor,
          },
        },
      } as Action;
  }
}

/** Restarts after the first run, for outcomes the executor left unknown. */
export const MAX_RESTARTS = 2;

/** Rehearsal: approve the plan's exact hash once, then run the executor with the read guard. */
export async function applyPlan(
  manifest: PlanManifest,
  ports: Ports,
  ctx: Contexts,
  policy: BillingPolicyV1,
): Promise<ApplyResult> {
  const log: string[] = [];
  const roles = [...new Set(manifest.actions.map((a) => a.requiredRole))].sort();
  if (manifest.actions.length === 0) {
    return { unresolved: 0, reviewerActions: 0, promptOpportunities: 0, log: ["empty plan"] };
  }
  const hash = planHash(manifest);
  const store = new MemoryApplyStore();
  store.runs.set("run", {
    planId: manifest.planId,
    revision: 1,
    planHash: hash,
    approvalId: "grant",
  });
  store.plans.set(`${manifest.planId}@1`, { planHash: hash, manifest });
  store.grants.set("grant", {
    id: "grant",
    orgId: manifest.orgId,
    planId: manifest.planId,
    revision: 1,
    planHash: hash,
    actorUserId: "user_scorecard",
    actorSessionId: "sess_scorecard",
    roles,
    grantedAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    revokedAt: null,
  });
  const clock = new FakeClock("2026-10-22T12:00:00.000Z");
  let n = 0;
  const deps = {
    store,
    journal: new MemoryJournal(),
    clock,
    providers: ports,
    worlds: ctx,
    policies: [policy],
    newId: (p: string) => `${p}_${++n}`,
    guard: createReadGuard({ providers: ports, worlds: ctx, clock }),
  };
  const job = {
    orgId: manifest.orgId,
    runId: "run",
    planId: manifest.planId,
    revision: 1,
    planHash: hash,
  };

  const latest = new Map<string, Receipt>();
  for (let run = 0; run <= MAX_RESTARTS; run++) {
    const result = await executeRun(job, deps);
    if (result.refusal) log.push(`run ${run + 1} refused: ${result.refusal}`);
    if (result.error) log.push(`run ${run + 1} error: ${result.error}`);
    for (const r of result.receipts) {
      latest.set(r.actionId, r);
      const why = r.holdReason ? ` (${r.holdReason.kind})` : "";
      log.push(`run ${run + 1}: ${r.actionId} ${r.outcome}${why}`);
    }
    if (![...latest.values()].some(isUnknown)) break;
  }
  return {
    unresolved: [...latest.values()].filter(isUnknown).length,
    reviewerActions: roles.length,
    promptOpportunities: roles.length,
    log,
  };
}

function isUnknown(r: Receipt): boolean {
  return r.outcome === "unknown_outcome" || r.holdReason?.kind === "unresolved_outcome";
}
