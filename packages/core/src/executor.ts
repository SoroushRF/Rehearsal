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
  ResultPath,
  type ResultRef,
  type RunState,
  type Vendor,
} from "@rehearsal/contracts";
import { bindingKey } from "./bindings";
import { topoOrder, validateGraph } from "./dag";
import { planHash as computePlanHash, fingerprint, sha256Hex } from "./hash";
import { type BillingPolicyV1, evaluateBillingPolicy } from "./policy";
import type {
  Clock,
  DispatchResult,
  JournalPort,
  Preconditions,
  PreparedRequest,
  ProviderPort,
  ReconcileResult,
  ResolvedBindings,
  SettleStep,
  SettleTransition,
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
  /** Bounded in-run retries; see DEFAULT_RETRY. */
  retry?: Partial<RetryPolicy>;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Minimum age before a negative read permits an identical idempotency-protected replay.
   * Non-idempotent unknown writes remain held regardless of age. Default 60 s.
   */
  reconcileAfterMs?: number;
}

export interface RetryPolicy {
  /** Total sends of one step in one run, including the first. */
  maxAttempts: number;
  /** Backoff without Retry-After: base, 2×base, 4×base… capped at maxDelayMs. */
  baseDelayMs: number;
  /** A Retry-After longer than this ends the run's retries for that step (no long sleeps). */
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 250, maxDelayMs: 10_000 };

export interface RunOutcome {
  state: RunState;
  receipts: Receipt[];
  refusal: string | null;
  /** Set when the run stopped early on an unexpected error; later steps were not attempted. */
  error: string | null;
}

const RESULT_PATHS: ReadonlySet<string> = new Set(ResultPath.options);

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
): {
  providerRef: EntityRef;
  results: Record<string, string | number>;
  /** What the provider's response says it now holds; T4's own-write overlay reads these. */
  observed: Record<string, unknown>;
} {
  if (action.kind === "stripe.refund.create") {
    const b = body as { id?: unknown; status?: unknown; amount?: unknown; charge?: unknown };
    if (typeof b?.id !== "string" || typeof b.amount !== "number" || typeof b.status !== "string") {
      throw new Error("refund response is missing id, status or amount");
    }
    const results = { "refund.id": b.id, "refund.status": b.status, "refund.amount": b.amount };
    return {
      providerRef: { vendor: "stripe", kind: "refund", id: b.id },
      results,
      observed: { ...results, charge: b.charge },
    };
  }
  const ticket = (body as { ticket?: Record<string, unknown> } | null)?.ticket;
  if (!ticket || typeof ticket !== "object") throw new Error("ticket response has no ticket");
  return {
    providerRef: targetOf(action),
    results: {},
    observed: { priority: ticket.priority, status: ticket.status, updated_at: ticket.updated_at },
  };
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

  for (const [vendor, ctx] of Object.entries(deps.worlds)) {
    if (ctx && ctx.world !== manifest.target.environment) {
      return {
        ok: false,
        detail: `${vendor} is configured for the ${ctx.world} world, not operational`,
      };
    }
  }

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
    opts: {
      transitions?: SettleStep["transitions"];
      transition?: SettleStep["transition"];
      results?: Record<string, string | number>;
    } = {},
  ) => {
    const newBindings: ObjectBinding[] = Object.entries(opts.results ?? {}).map(
      ([path, value]) => ({
        planHash: job.planHash,
        ref: { $ref: "result", stepId: action.id, path: path as ResultRef["path"] },
        value,
      }),
    );
    await journal.settle({
      transitions: opts.transitions,
      transition: opts.transition,
      bindings: newBindings,
      receipt,
    });
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
    a.request.method === req.method &&
    a.request.path === req.path &&
    a.request.encoding === req.encoding &&
    a.request.bodySha256 === sha;

  /** A read result's values a later step may bind to (the allowlisted ResultPaths only). */
  const bindable = (effect: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(effect).filter(
        (e): e is [string, string | number] =>
          RESULT_PATHS.has(e[0]) && (typeof e[1] === "string" || typeof e[1] === "number"),
      ),
    );

  /**
   * Resolve in-flight attempts of one key through the provider's reads. "settled" means the step
   * now has its receipt (confirmed, or held); otherwise the read showed nothing was applied and
   * the attempts were closed as rejected (no status), so the step may be sent.
   */
  async function reconcileInFlight(
    action: Action,
    key: string,
    inFlight: Attempt[],
    provider: ProviderPort,
    world: WorldContext,
    sameAsNewest: boolean,
  ): Promise<"settled" | "resend"> {
    const newest = inFlight.at(-1) as Attempt;
    let result: ReconcileResult;
    try {
      result = await provider.reconcile(newest, action, world);
    } catch (err) {
      result = {
        kind: "indeterminate",
        detail: `reconcile read failed: ${(err as Error).message}`,
      };
    }
    await journal
      .appendEvent(job.runId, "step.reconcile", {
        actionId: action.id,
        attemptId: newest.id,
        result,
      })
      .catch(() => {});

    const toUnknown = (a: Attempt): SettleTransition[] =>
      a.state === "dispatched"
        ? [
            {
              attemptId: a.id,
              from: "dispatched",
              to: "unknown_outcome",
              patch: { error: "outcome unknown" },
            },
          ]
        : [];

    const reconciled = (): SettleTransition[] =>
      inFlight.flatMap((a) => [
        ...toUnknown(a),
        { attemptId: a.id, from: "unknown_outcome", to: "reconciled", patch: { settledAt: at() } },
      ]);

    if (result.kind === "applied" && !sameAsNewest) {
      // The effect happened, but for different content than this revision approved.
      await settle(
        action,
        receiptFor(action, "held", {
          holdReason: {
            kind: "approval_invalid",
            detail: `operation ${key} was applied with different content (attempt ${newest.id}); a new action is needed`,
          },
          observedEffect: result.effect,
        }),
        { transitions: reconciled() },
      );
      return "settled";
    }
    if (result.kind === "applied") {
      const results = bindable(result.effect);
      await settle(
        action,
        receiptFor(action, "confirmed", {
          providerRef: result.providerRef,
          observedEffect: result.effect,
          limitations: [
            `outcome of attempt ${newest.id} (key ${key}) found by reading the provider; not re-sent`,
          ],
        }),
        { transitions: reconciled(), results },
      );
      return "settled";
    }

    // A request can still land after a read that missed it (a slow server, a dying process's
    // socket). Age alone never makes an append safe: a negative read permits only an
    // identical replay protected by the provider's idempotency guarantee.
    const sentAt = Date.parse(newest.dispatchedAt ?? newest.preparedAt);
    const oldEnough = clock.now().getTime() - sentAt >= (deps.reconcileAfterMs ?? 60_000);
    if (
      result.kind === "not_applied" &&
      oldEnough &&
      sameAsNewest &&
      provider.idempotentResend?.(action)
    ) {
      for (const a of inFlight) {
        for (const t of toUnknown(a)) await journal.transition(t.attemptId, t.from, t.to, t.patch);
        await journal.transition(a.id, "unknown_outcome", "rejected", {
          providerStatus: null,
          error: "no effect visible; identical idempotent replay permitted",
          settledAt: at(),
        });
      }
      return "resend";
    }
    await hold(action, { kind: "unresolved_outcome", attemptId: inFlight[0]?.id ?? newest.id });
    return "settled";
  }

  async function step(action: Action): Promise<void> {
    if (confirmedByAction.has(action.id)) {
      // Already confirmed (or adopted) for this hash in an earlier run; never settle it twice.
      settled.set(action.id, "confirmed");
      return;
    }
    const key = operationKey(job.orgId, job.planId, action);
    const vendor = vendorOf(action);
    const provider = deps.providers[vendor];
    const world = deps.worlds[vendor];
    if (!provider || !world) throw new Error(`no operational provider configured for ${vendor}`);

    const refs = resultRefsOf(action);
    const unresolved = refs.find((r) => !bindings.has(bindingKey(r)));
    const resolved: ResolvedBindings = new Map(
      refs.map((r) => [bindingKey(r), bindings.get(bindingKey(r)) as string | number]),
    );

    /** The request this step would send, given these preconditions. */
    const prepareWith = (pre: Preconditions) => {
      const req = provider.prepare(action, resolved, key, pre);
      return { req, sha: sha256Hex(req.body) };
    };
    /**
     * Same content as an earlier attempt, re-prepared with the preconditions that attempt carried.
     * Our own writes move values like Zendesk's updated_stamp, so a fresh read can't be compared.
     */
    const sameContent = (a: Attempt) => {
      try {
        const { req, sha } = prepareWith(provider.preconditionsOf?.(a.request) ?? {});
        return sameRequest(a, req, sha);
      } catch {
        return false; // Can't rebuild it from the journaled request: treat as different, so hold.
      }
    };

    let prior = await journal.attemptsForKey(key);
    const inFlight = prior.filter((a) => a.state === "dispatched" || a.state === "unknown_outcome");
    if (inFlight.length > 0) {
      // An earlier send's outcome is unknown (a lost response, a crash after dispatch). Ask the
      // provider through authoritative reads; never re-send on a guess.
      // An effect found under different content (a revision changed the amount or text) is
      // recorded but never confirmed as this revision's.
      const sameAsNewest = sameContent(inFlight.at(-1) as Attempt);
      const outcome = await reconcileInFlight(action, key, inFlight, provider, world, sameAsNewest);
      if (outcome === "settled") return;
      prior = await journal.attemptsForKey(key); // read showed no effect: the step may be sent
    }
    /**
     * Decisions follow the newest attempt that was actually sent, under any revision. Prepared rows
     * were never sent: they matter only when nothing for this key has been sent yet, and then only
     * this hash's own (another revision's prepared row neither blocks nor gets reused).
     */
    const latest = prior.filter((a) => a.state !== "prepared").at(-1);
    const ownPrepared = latest
      ? undefined
      : prior.filter((a) => a.state === "prepared" && a.planHash === job.planHash).at(-1);

    if (
      latest &&
      (latest.state === "confirmed" || latest.state === "reconciled") &&
      latest.planHash === job.planHash
    ) {
      // This hash's own attempt was applied, yet this hash has no receipt for it (the
      // confirmedByAction check above would have returned): another revision's run reconciled it.
      // Read it back so this hash records its own receipt and bindings; never re-send.
      if (unresolved) {
        return hold(action, { kind: "predecessor_not_confirmed", stepId: unresolved.stepId });
      }
      let back: ReconcileResult;
      try {
        back = sameContent(latest)
          ? await provider.reconcile(latest, action, world)
          : { kind: "indeterminate", detail: "can't rebuild the journaled request" };
      } catch (err) {
        back = { kind: "indeterminate", detail: (err as Error).message };
      }
      if (back.kind !== "applied") {
        return hold(action, { kind: "unresolved_outcome", attemptId: latest.id });
      }
      return settle(
        action,
        receiptFor(action, "confirmed", {
          providerRef: back.providerRef,
          observedEffect: back.effect,
          limitations: [
            `applied by attempt ${latest.id}, resolved by another revision's run; read back, not re-sent`,
          ],
        }),
        { results: bindable(back.effect) },
      );
    }
    if (unresolved) {
      return hold(action, { kind: "predecessor_not_confirmed", stepId: unresolved.stepId });
    }
    if (latest) {
      if (!sameContent(latest)) {
        return hold(action, {
          kind: "approval_invalid",
          detail: `operation ${key} was already attempted (${latest.state}) with different content; a new action is needed`,
        });
      }
      // A 429 had no effect. A negative read (no status) permits only idempotent replay.
      if (
        latest.state === "rejected" &&
        latest.providerStatus === null &&
        !provider.idempotentResend?.(action)
      ) {
        // Older executors treated a negative read as terminal proof. Do not reuse that
        // inference to re-send a possibly still-pending append or field write.
        return hold(action, { kind: "unresolved_outcome", attemptId: latest.id });
      }
      const noEffect = latest.providerStatus === 429 || latest.providerStatus === null;
      if (latest.state === "rejected" && !noEffect) {
        // A definite refusal (validation, permission, conflict) is never re-sent by a later run.
        return settle(
          action,
          receiptFor(action, "rejected", {
            observedEffect: { status: latest.providerStatus },
            limitations: [`rejected by attempt ${latest.id}; not re-sent`],
          }),
        );
      }
    }
    if (latest && latest.state !== "rejected") {
      // Confirmed under an earlier revision of this plan with the same content: adopt its results.
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

    let pre: Preconditions = {};
    if (provider.preconditions) {
      try {
        pre = await provider.preconditions(action, world);
      } catch (err) {
        return hold(action, {
          kind: "unsupported_protection",
          detail: `could not read the write's precondition: ${(err as Error).message}`,
        });
      }
    }
    // Capture the native stamp before semantic validation. A later read must never forgive
    // a teammate's intervening edit by replacing the stamp after the guard has passed.
    const guardHold = deps.guard
      ? await deps.guard(action, { manifest, confirmedReceipts: [...confirmedByAction.values()] })
      : null;
    if (guardHold) return hold(action, guardHold);
    const { req: request, sha: bodySha256 } = prepareWith(pre);

    // A never-sent prepared row of this hash: reuse its exact bytes if nothing moved. If only a
    // precondition moved (same content, new stamp), supersede it with a fresh attempt; it was
    // never sent, so it can't have had an effect.
    let reuse: Attempt | null = null;
    if (ownPrepared) {
      if (sameRequest(ownPrepared, request, bodySha256)) reuse = ownPrepared;
      else if (!sameContent(ownPrepared)) {
        return hold(action, {
          kind: "approval_invalid",
          detail: "re-prepared request differs from the journaled bytes",
        });
      }
    }

    const policy = { ...DEFAULT_RETRY, ...deps.retry };
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const backoff = (n: number) => Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (n - 1));
    let attemptNo = prior.at(-1)?.attemptNo ?? 0;
    let attemptId: string | undefined = reuse?.id;
    /** Attempts in this loop left unknown before an idempotent re-send; reconciled by its replay. */
    const unknownSends: string[] = [];
    const retried = (n: number) => (n > 1 ? [`sent ${n} times with identical bytes`] : []);

    for (let n = 1; ; n++) {
      if (!attemptId) {
        attemptId = deps.newId("att");
        attemptNo += 1;
        await journal.prepareAttempt({
          id: attemptId,
          actionId: action.id,
          planHash: job.planHash,
          operationKey: key,
          attemptNo,
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
      const current: string = attemptId;
      // Marked dispatched BEFORE the network call: a crash after this point is an unknown outcome.
      await journal.transition(current, "prepared", "dispatched", { dispatchedAt: at() });
      inFlightAttempt = current;

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
          const { providerRef, results, observed } = parsed;
          return settle(
            action,
            receiptFor(action, "confirmed", {
              providerRef,
              observedEffect: observed,
              limitations: [
                "effect taken from the write response; no read-back yet",
                ...retried(n),
              ],
            }),
            {
              // The replay answered for the earlier unknown sends of the same bytes and key.
              transitions: unknownSends.map((id) => ({
                attemptId: id,
                from: "unknown_outcome" as const,
                to: "reconciled" as const,
                patch: { settledAt: at() },
              })),
              transition: {
                attemptId: current,
                from: "dispatched",
                to: "confirmed",
                patch: { providerStatus: result.status, settledAt: at() },
              },
              results,
            },
          );
        }
      }

      const canRetry = n < policy.maxAttempts;
      if (result.kind === "rejected") {
        const rejectedPatch = {
          providerStatus: result.status,
          error: JSON.stringify(result.body).slice(0, 500),
          settledAt: at(),
        };
        const delay = result.retryAfterMs ?? backoff(n);
        if (result.retryable && canRetry && delay <= policy.maxDelayMs) {
          // A retryable refusal (429) had no effect: send the same bytes again after the delay.
          await journal.transition(current, "dispatched", "rejected", rejectedPatch);
          // An earlier unknown send may still have applied; the run isn't settled until it is.
          inFlightAttempt = unknownSends[0] ?? null;
          await journal
            .appendEvent(job.runId, "step.retry", {
              actionId: action.id,
              attemptId: current,
              status: result.status,
              delayMs: delay,
            })
            .catch(() => {});
          await sleep(delay);
          attemptId = undefined;
          continue;
        }
        if (unknownSends.length > 0) {
          // This send was refused, but an earlier one of the same bytes has an unknown outcome:
          // money may have moved, so the step is unknown, never "rejected".
          return settle(
            action,
            receiptFor(action, "unknown_outcome", {
              holdReason: { kind: "unresolved_outcome", attemptId: unknownSends[0] as string },
              limitations: [
                ...retried(n),
                `last send refused with ${result.status}; an earlier send's outcome is unknown`,
              ],
            }),
            {
              transition: {
                attemptId: current,
                from: "dispatched",
                to: "rejected",
                patch: rejectedPatch,
              },
            },
          );
        }
        const why = !result.retryable
          ? []
          : !canRetry
            ? ["retry budget exhausted; a later run may send it again"]
            : [
                `Retry-After of ${delay} ms exceeds the ${policy.maxDelayMs} ms cap; a later run may send it again`,
              ];
        return settle(
          action,
          receiptFor(action, "rejected", {
            observedEffect: { status: result.status },
            limitations: [...retried(n), ...why],
          }),
          {
            transition: {
              attemptId: current,
              from: "dispatched",
              to: "rejected",
              patch: rejectedPatch,
            },
          },
        );
      }

      const unknownError = result.kind === "unknown" ? result.error : null;
      if (canRetry && provider.idempotentResend?.(action)) {
        // The provider dedupes identical bytes under this key, so a re-send can't apply it twice:
        // it either applies once or replays the original response.
        await journal.transition(current, "dispatched", "unknown_outcome", { error: unknownError });
        unknownSends.push(current);
        await journal
          .appendEvent(job.runId, "step.retry", {
            actionId: action.id,
            attemptId: current,
            unknown: unknownError,
          })
          .catch(() => {});
        await sleep(backoff(n));
        attemptId = undefined;
        continue;
      }
      return settle(
        action,
        receiptFor(action, "unknown_outcome", {
          holdReason: { kind: "unresolved_outcome", attemptId: unknownSends[0] ?? current },
          limitations: retried(n),
        }),
        {
          transition: {
            attemptId: current,
            from: "dispatched",
            to: "unknown_outcome",
            patch: { error: unknownError },
          },
        },
      );
    }
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
