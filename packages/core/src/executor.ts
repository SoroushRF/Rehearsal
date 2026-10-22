import {
  type Action,
  type ApprovalGrant,
  type Attempt,
  type EntityRef,
  type HoldReason,
  type ObjectBinding,
  PlanManifest,
  type Receipt,
  type ReceiptOutcome,
  type ResultRef,
  type RunState,
  type Vendor,
} from "@rehearsal/contracts";
import { topoOrder, validateGraph } from "./dag";
import { planHash as computePlanHash, fingerprint, sha256Hex } from "./hash";
import { type BillingPolicyV1, evaluateBillingPolicy } from "./policy";
import type {
  Clock,
  DispatchResult,
  JournalPort,
  PreparedRequest,
  ProviderPort,
  ResolvedBindings,
  SettleStep,
  WorldContext,
} from "./ports";

/** What one `apply` job names. The executor trusts none of it until admission re-checks it. */
export interface ApplyJobInput {
  orgId: string;
  runId: string;
  planId: string;
  revision: number;
  planHash: string;
}

export interface StoredRun {
  planId: string;
  revision: number;
  planHash: string;
  approvalId: string;
}

/** Read-only access to the stored run, plan and grant (Postgres in the worker, memory in tests). */
export interface ApplyStore {
  loadRun(orgId: string, runId: string): Promise<StoredRun | null>;
  loadPlan(
    orgId: string,
    planId: string,
    revision: number,
  ): Promise<{ planHash: string; manifest: unknown } | null>;
  loadGrant(orgId: string, approvalId: string): Promise<ApprovalGrant | null>;
  /**
   * Exclusive apply lock for one plan (all its revisions). Returns a release function, or null if
   * another run of this plan holds it. Two revisions applying at once could both send one key.
   */
  lockPlan(orgId: string, planId: string): Promise<(() => Promise<void>) | null>;
}

export interface StepGuardContext {
  manifest: PlanManifest;
  /** Every confirmed receipt for this plan hash so far, including earlier runs (own-write overlay). */
  confirmedReceipts: readonly Receipt[];
}

/**
 * Per-step guard hook (T4). Runs only before a request would actually be sent; returning a reason
 * holds the step. The model never sits here.
 */
export type StepGuard = (action: Action, ctx: StepGuardContext) => Promise<HoldReason | null>;

export interface ExecutorDeps {
  store: ApplyStore;
  journal: JournalPort;
  providers: Partial<Record<Vendor, ProviderPort>>;
  /** Operational world tenant per vendor. */
  worlds: Partial<Record<Vendor, WorldContext>>;
  clock: Clock;
  policies: readonly BillingPolicyV1[];
  newId: (prefix: string) => string;
  guard?: StepGuard;
}

export interface RunOutcome {
  state: RunState;
  receipts: Receipt[];
  refusal: string | null;
  /** Set when the run stopped early on an unexpected error; later steps were not attempted. */
  error: string | null;
}

export const bindingKey = (ref: Pick<ResultRef, "stepId" | "path">) => `${ref.stepId}:${ref.path}`;

export function vendorOf(action: Action): Vendor {
  return action.kind.startsWith("stripe.") ? "stripe" : "zendesk";
}

function targetOf(action: Action): EntityRef {
  switch (action.kind) {
    case "stripe.refund.create":
      return { vendor: "stripe", kind: "charge", id: action.args.chargeId };
    case "zendesk.ticket.patchFields":
    case "zendesk.ticket.appendPrivateNote":
      return { vendor: "zendesk", kind: "ticket", id: action.args.ticketId };
  }
}

/**
 * Idempotency key for one action. Stable across revisions of the same plan (revisions keep action
 * IDs), so a re-approved revision finds the earlier attempt instead of issuing a second refund;
 * unique per action within a plan, so two notes on one ticket never share a key.
 */
export function operationKey(orgId: string, planId: string, action: Action): string {
  const t = targetOf(action);
  return `op_${fingerprint({
    orgId,
    planId,
    actionId: action.id,
    kind: action.kind,
    obligationId: action.obligationId,
    target: t,
  }).slice(0, 32)}`;
}

/** Allowlisted values a confirmed response yields for later steps, plus the created object. */
function resultsOf(
  action: Action,
  body: unknown,
): { providerRef: EntityRef; results: Record<string, string | number> } {
  if (action.kind === "stripe.refund.create") {
    const b = body as { id?: unknown; status?: unknown; amount?: unknown };
    if (typeof b?.id !== "string" || typeof b.amount !== "number" || typeof b.status !== "string") {
      throw new Error("refund response is missing id, status or amount");
    }
    return {
      providerRef: { vendor: "stripe", kind: "refund", id: b.id },
      results: { "refund.id": b.id, "refund.status": b.status, "refund.amount": b.amount },
    };
  }
  return { providerRef: targetOf(action), results: {} };
}

function resultRefsOf(action: Action): ResultRef[] {
  if (action.kind !== "zendesk.ticket.appendPrivateNote") return [];
  return Object.values(action.args.bindings).filter(
    (b): b is ResultRef => typeof b === "object" && b !== null,
  );
}

/** Run-level admission. Any failure means nothing is dispatched. */
async function admit(
  job: ApplyJobInput,
  deps: ExecutorDeps,
): Promise<
  { ok: true; manifest: PlanManifest; grant: ApprovalGrant } | { ok: false; detail: string }
> {
  const run = await deps.store.loadRun(job.orgId, job.runId);
  if (!run) return { ok: false, detail: "run not found" };
  if (run.planId !== job.planId || run.revision !== job.revision || run.planHash !== job.planHash) {
    return { ok: false, detail: "job does not match the stored run" };
  }

  const stored = await deps.store.loadPlan(job.orgId, job.planId, job.revision);
  if (!stored) return { ok: false, detail: "plan revision not found" };
  if (stored.planHash !== job.planHash)
    return { ok: false, detail: "stored hash differs from the job" };
  const parsed = PlanManifest.safeParse(stored.manifest);
  if (!parsed.success) return { ok: false, detail: "stored manifest is invalid" };
  if (computePlanHash(parsed.data) !== job.planHash) {
    return { ok: false, detail: "stored manifest does not hash to the approved hash" };
  }
  const manifest = parsed.data;
  if (manifest.orgId !== job.orgId) return { ok: false, detail: "manifest belongs to another org" };

  const grant = await deps.store.loadGrant(job.orgId, run.approvalId);
  if (!grant) return { ok: false, detail: "approval grant not found" };
  const now = deps.clock.now().getTime();
  if (
    grant.orgId !== job.orgId ||
    grant.planId !== job.planId ||
    grant.revision !== job.revision ||
    grant.planHash !== job.planHash
  ) {
    return { ok: false, detail: "grant is for a different plan, revision or hash" };
  }
  if (grant.revokedAt !== null) return { ok: false, detail: "grant was revoked" };
  const grantedAt = Date.parse(grant.grantedAt);
  const expiresAt = Date.parse(grant.expiresAt);
  if (Number.isNaN(grantedAt) || Number.isNaN(expiresAt)) {
    return { ok: false, detail: "grant timestamps are unreadable" };
  }
  if (grantedAt > now) return { ok: false, detail: "grant is dated in the future" };
  if (expiresAt <= now) return { ok: false, detail: "grant expired" };
  const missing = [...new Set(manifest.actions.map((a) => a.requiredRole))].filter(
    (r) => !grant.roles.includes(r),
  );
  if (missing.length > 0) return { ok: false, detail: `grant lacks roles: ${missing.join(", ")}` };

  const graph = validateGraph(manifest.actions);
  if (graph.length > 0) return { ok: false, detail: `invalid graph: ${graph[0]?.detail}` };
  for (const ref of manifest.policies) {
    const policy = deps.policies.find((p) => p.id === ref.id && p.version === ref.version);
    if (!policy) return { ok: false, detail: `policy ${ref.id}@${ref.version} is not loaded` };
    const { violations } = evaluateBillingPolicy(manifest, policy);
    if (violations.length > 0) {
      return { ok: false, detail: `policy ${violations[0]?.rule}: ${violations[0]?.detail}` };
    }
  }
  return { ok: true, manifest, grant };
}

/**
 * Deterministic apply of one approved plan. No model is consulted. Each step is journaled with its
 * exact bytes before it is sent; a failed, held or unknown step skips everything that depends on it.
 */
export async function executeRun(job: ApplyJobInput, deps: ExecutorDeps): Promise<RunOutcome> {
  const { journal } = deps;
  const admission = await admit(job, deps);

  if (!admission.ok) {
    await journal.appendEvent(job.runId, "run.refused", { detail: admission.detail });
    return { state: "failed", receipts: [], refusal: admission.detail, error: null };
  }
  const { manifest, grant } = admission;
  const release = await deps.store.lockPlan(job.orgId, job.planId);
  if (!release) {
    const detail = "another run of this plan is applying";
    await journal.appendEvent(job.runId, "run.deferred", { detail });
    return { state: "held", receipts: [], refusal: detail, error: null };
  }
  try {
    return await applyLocked(job, deps, manifest, grant);
  } finally {
    await release();
  }
}

async function applyLocked(
  job: ApplyJobInput,
  deps: ExecutorDeps,
  manifest: PlanManifest,
  grant: ApprovalGrant,
): Promise<RunOutcome> {
  const { journal, clock } = deps;
  const at = () => clock.now().toISOString();
  await journal.appendEvent(job.runId, "run.admitted", {
    planHash: job.planHash,
    approvalId: grant.id,
  });

  const receipts: Receipt[] = [];
  const settled = new Map<string, ReceiptOutcome>();
  /** Latest confirmed receipt per action for this hash (earlier runs included), never duplicated. */
  const confirmedByAction = new Map<string, Receipt>();
  for (const r of await journal.receiptsFor(job.planHash)) {
    if (r.outcome === "confirmed") confirmedByAction.set(r.actionId, r);
  }
  /** An attempt marked dispatched whose outcome isn't settled yet (for honest error labelling). */
  let inFlightAttempt: string | null = null;
  const bindings = new Map<string, string | number>(
    (await journal.bindings(job.planHash)).map((b) => [bindingKey(b.ref), b.value]),
  );

  const receiptFor = (
    action: Action,
    outcome: ReceiptOutcome,
    extra: Partial<
      Pick<Receipt, "providerRef" | "observedEffect" | "holdReason" | "limitations">
    > = {},
  ): Receipt => ({
    id: deps.newId("rcp"),
    actionId: action.id,
    planHash: job.planHash,
    approvalId: grant.id,
    outcome,
    providerRef: extra.providerRef ?? null,
    observedEffect: extra.observedEffect ?? {},
    protection: action.protection,
    holdReason: extra.holdReason ?? null,
    limitations: extra.limitations ?? [],
    recordedAt: at(),
  });

  /** Journal the receipt (with any transition and bindings) atomically, then publish it. */
  const settle = async (
    action: Action,
    receipt: Receipt,
    opts: { transition?: SettleStep["transition"]; results?: Record<string, string | number> } = {},
  ) => {
    const newBindings: ObjectBinding[] = Object.entries(opts.results ?? {}).map(
      ([path, value]) => ({
        planHash: job.planHash,
        ref: { $ref: "result", stepId: action.id, path: path as ResultRef["path"] },
        value,
      }),
    );
    await journal.settle({ transition: opts.transition, bindings: newBindings, receipt });
    // The journal is the record: reflect it in memory before anything else can fail.
    for (const b of newBindings) bindings.set(bindingKey(b.ref), b.value);
    receipts.push(receipt);
    if (receipt.outcome === "confirmed") confirmedByAction.set(receipt.actionId, receipt);
    settled.set(action.id, receipt.outcome);
    if (opts.transition?.attemptId === inFlightAttempt) inFlightAttempt = null;
    // Events are a feed for the UI, not the record; losing one must not change the outcome.
    await journal.appendEvent(job.runId, "step.receipt", receipt).catch(() => {});
  };
  const hold = (action: Action, holdReason: HoldReason) =>
    settle(action, receiptFor(action, "held", { holdReason }));

  const sameRequest = (a: Attempt, req: PreparedRequest, sha: string) =>
    a.request.method === req.method && a.request.path === req.path && a.request.bodySha256 === sha;

  async function step(action: Action): Promise<void> {
    if (confirmedByAction.has(action.id)) {
      // Already confirmed (or adopted) for this hash in an earlier run; never settle it twice.
      settled.set(action.id, "confirmed");
      return;
    }
    const key = operationKey(job.orgId, job.planId, action);
    const prior = await journal.attemptsForKey(key);
    // A prepared attempt from another plan hash was never sent; it neither blocks nor gets reused.
    const relevant = prior.filter((a) => a.state !== "prepared" || a.planHash === job.planHash);
    const latest = relevant.at(-1);

    if (
      latest &&
      (latest.state === "confirmed" || latest.state === "reconciled") &&
      latest.planHash === job.planHash
    ) {
      // Applied by an earlier run of this plan hash; settle() wrote its receipt and bindings.
      settled.set(action.id, "confirmed");
      return;
    }
    const inFlight = prior.find((a) => a.state === "dispatched" || a.state === "unknown_outcome");
    if (inFlight) {
      // TODO(T3.5): reconcile through reads. Until then never re-send; hold for an operator.
      return hold(action, { kind: "unresolved_outcome", attemptId: inFlight.id });
    }

    const refs = resultRefsOf(action);
    const unresolved = refs.find((r) => !bindings.has(bindingKey(r)));
    if (unresolved) {
      return hold(action, { kind: "predecessor_not_confirmed", stepId: unresolved.stepId });
    }
    const resolved: ResolvedBindings = new Map(
      refs.map((r) => [bindingKey(r), bindings.get(bindingKey(r)) as string | number]),
    );

    const vendor = vendorOf(action);
    const provider = deps.providers[vendor];
    const world = deps.worlds[vendor];
    if (!provider || !world) throw new Error(`no operational provider configured for ${vendor}`);

    const request: PreparedRequest = provider.prepare(action, resolved, key);
    const bodySha256 = sha256Hex(request.body);

    if (latest && latest.state !== "prepared") {
      if (!sameRequest(latest, request, bodySha256)) {
        return hold(action, {
          kind: "approval_invalid",
          detail: `operation ${key} was already attempted (${latest.state}) with different content; a new action is needed`,
        });
      }
      if (latest.state === "rejected") {
        // Never auto-resend a rejected request outside the bounded retry policy (T3.4).
        return settle(
          action,
          receiptFor(action, "rejected", {
            observedEffect: { status: latest.providerStatus },
            limitations: [`rejected by attempt ${latest.id}; not re-sent`],
          }),
        );
      }
      // Confirmed under an earlier revision of this plan with identical bytes: adopt its results.
      const earlier = (await journal.bindings(latest.planHash)).filter(
        (b) => b.ref.stepId === latest.actionId,
      );
      const results = Object.fromEntries(earlier.map((b) => [b.ref.path, b.value]));
      const refund = results["refund.id"];
      return settle(
        action,
        receiptFor(action, "confirmed", {
          providerRef:
            typeof refund === "string"
              ? { vendor: "stripe", kind: "refund", id: refund }
              : targetOf(action),
          observedEffect: results,
          limitations: [
            `applied by attempt ${latest.id} under plan hash ${latest.planHash}; not re-sent`,
          ],
        }),
        { results },
      );
    }

    // Only now would a request actually be sent, so only now do the guards run.
    const guardHold = deps.guard
      ? await deps.guard(action, { manifest, confirmedReceipts: [...confirmedByAction.values()] })
      : null;
    if (guardHold) return hold(action, guardHold);

    if (latest?.state === "prepared" && !sameRequest(latest, request, bodySha256)) {
      return hold(action, {
        kind: "approval_invalid",
        detail: "re-prepared request differs from the journaled bytes",
      });
    }

    const attemptId = latest?.state === "prepared" ? latest.id : deps.newId("att");
    if (latest?.state !== "prepared") {
      await journal.prepareAttempt({
        id: attemptId,
        actionId: action.id,
        planHash: job.planHash,
        operationKey: key,
        attemptNo: (prior.at(-1)?.attemptNo ?? 0) + 1,
        state: "prepared",
        request: {
          method: request.method,
          path: request.path,
          encoding: request.encoding,
          body: request.body,
          bodySha256,
        },
        providerStatus: null,
        error: null,
        preparedAt: at(),
        dispatchedAt: null,
        settledAt: null,
      });
    }
    // Marked dispatched BEFORE the network call: a crash after this point is an unknown outcome.
    await journal.transition(attemptId, "prepared", "dispatched", { dispatchedAt: at() });
    inFlightAttempt = attemptId;

    let result: DispatchResult;
    try {
      result = await provider.dispatch(request, world);
    } catch (err) {
      result = { kind: "unknown", error: (err as Error).message };
    }

    if (result.kind === "confirmed") {
      let parsed: ReturnType<typeof resultsOf> | null = null;
      try {
        parsed = resultsOf(action, result.body);
      } catch (err) {
        // The provider says it worked but we can't read what it did: treat it as unknown.
        result = {
          kind: "unknown",
          error: `unreadable confirmed response: ${(err as Error).message}`,
        };
      }
      if (parsed && result.kind === "confirmed") {
        const { providerRef, results } = parsed;
        return settle(
          action,
          receiptFor(action, "confirmed", {
            providerRef,
            observedEffect: results,
            limitations: ["effect taken from the write response; no read-back yet"],
          }),
          {
            transition: {
              attemptId,
              from: "dispatched",
              to: "confirmed",
              patch: { providerStatus: result.status, settledAt: at() },
            },
            results,
          },
        );
      }
    }
    if (result.kind === "rejected") {
      // TODO(T3.4): bounded retries with the identical request when `retryable`.
      return settle(
        action,
        receiptFor(action, "rejected", { observedEffect: { status: result.status } }),
        {
          transition: {
            attemptId,
            from: "dispatched",
            to: "rejected",
            patch: {
              providerStatus: result.status,
              error: JSON.stringify(result.body).slice(0, 500),
              settledAt: at(),
            },
          },
        },
      );
    }
    return settle(
      action,
      receiptFor(action, "unknown_outcome", {
        holdReason: { kind: "unresolved_outcome", attemptId },
      }),
      {
        transition: {
          attemptId,
          from: "dispatched",
          to: "unknown_outcome",
          patch: { error: result.kind === "unknown" ? result.error : null },
        },
      },
    );
  }

  let error: string | null = null;
  for (const action of topoOrder(manifest.actions)) {
    const blocked = action.dependsOn.find((d) => settled.get(d) !== "confirmed");
    try {
      if (blocked) {
        await settle(
          action,
          receiptFor(action, "skipped_dependency", {
            holdReason: { kind: "predecessor_not_confirmed", stepId: blocked },
          }),
        );
        continue;
      }
      await step(action);
    } catch (err) {
      // Unexpected failure (journal down, adapter bug). Stop: the remaining steps are not attempted,
      // and anything already dispatched stays in the journal as dispatched, so it is never re-sent.
      error = `${action.id}: ${(err as Error).message}`;
      await journal
        .appendEvent(job.runId, "step.error", { actionId: action.id, error })
        .catch(() => {});
      break;
    }
  }

  const outcomes = manifest.actions.map((a) => settled.get(a.id));
  const confirmed = outcomes.filter((o) => o === "confirmed").length;
  const state: RunState =
    confirmed === outcomes.length
      ? "completed"
      : confirmed > 0
        ? "partial"
        : inFlightAttempt !== null || outcomes.some((o) => o === "held" || o === "unknown_outcome")
          ? "held"
          : "failed";
  await journal.appendEvent(job.runId, "run.finished", { state, error }).catch(() => {});
  return { state, receipts, refusal: null, error };
}
