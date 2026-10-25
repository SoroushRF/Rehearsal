import {
  type Action,
  type ApprovalGrant,
  type Attempt,
  type AttemptState,
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
  ZendeskPriority,
  ZendeskStatus,
} from "@rehearsal/contracts";
import {
  dualApprovalStatus,
  explainShortfall,
  liveGrantsFor,
  requiresDualApproval,
} from "./approvals";
import { bindingKey } from "./bindings";
import { topoOrder, validateGraph } from "./dag";
import { creditEffectMatches, refundEffectMatches } from "./effects";
import { planHash as computePlanHash, fingerprint, sha256Hex } from "./hash";
import { type BillingPolicy, evaluateBillingPolicy } from "./policy";
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
import { remedyOf } from "./remedy";
import { replyBodyFor, summaryCountKey } from "./templates";

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
   * Every grant ever made for this plan hash, live or not; admission filters. Needed only for a
   * plan that policy says needs two approvers. A store without it refuses such a plan.
   */
  loadGrantsForPlanHash?(orgId: string, planHash: string): Promise<ApprovalGrant[]>;
  /**
   * Exclusive apply lock for one plan (all its revisions). Returns a release function, or null if
   * another run of this plan holds it. Two revisions applying at once could both send one key.
   */
  lockPlan(orgId: string, planId: string): Promise<(() => Promise<void>) | null>;
  /**
   * True once someone cancelled this run. Checked before admission, before every step and before
   * every send: a cancel stops the next admitted action; what already happened keeps its receipt.
   */
  runCancelled?(orgId: string, runId: string): Promise<boolean>;
  /**
   * Every refund or credit step for this obligation in any stored plan revision of the org. The
   * one-remedy guard reads their attempts (decision 0010 item 4); without it, a remedy holds.
   */
  remedyStepsFor?(orgId: string, obligationId: string): Promise<RemedyStepRef[]>;
}

/** A refund or credit step in a stored plan revision. */
export interface RemedyStepRef {
  planHash: string;
  actionId: string;
}

/** One journaled attempt of another remedy step for the same obligation. */
export interface PriorRemedy extends RemedyStepRef {
  attemptId: string;
  state: AttemptState;
}

export interface StepGuardContext {
  manifest: PlanManifest;
  /** Every confirmed receipt for this plan hash so far, including earlier runs (own-write overlay). */
  confirmedReceipts: readonly Receipt[];
  /**
   * For a refund or credit: every attempt of another remedy step for its obligation, in any plan
   * or revision of the org (this operation's own attempts excluded). Undefined when the store
   * can't list them, which the guard treats as unknown, never as none.
   */
  priorRemedies?: readonly PriorRemedy[];
}

/**
 * Per-step guard hook (T4). Runs only before a request would actually be sent; returning a reason
 * holds the step. The model never sits here.
 */
export type StepGuard = (action: Action, ctx: StepGuardContext) => Promise<HoldReason | null>;

/** One compensation receipt for an action, settled atomically with its attempt transition. */
export interface CompensationResult
  extends Partial<Pick<Receipt, "providerRef" | "observedEffect" | "holdReason" | "limitations">> {
  outcome: ReceiptOutcome;
  transition?: SettleTransition;
}

export interface CompensationContext {
  orgId: string;
  planHash: string;
  manifest: PlanManifest;
  /** This run's outcome per action; actions it never reached are absent. */
  outcomes: ReadonlyMap<string, ReceiptOutcome>;
  /** Every receipt for this plan hash so far, this run's included. */
  receipts: readonly Receipt[];
  journal: JournalPort;
  newId: (prefix: string) => string;
  /** False once the run is cancelled or its grant was revoked, changed or expired. */
  maySend: () => Promise<boolean>;
  record: (action: Action, result: CompensationResult) => Promise<void>;
  /** How long a lost undo must age before a negative read may send a fresh one. */
  reconcileAfterMs?: number;
}

/**
 * Compensation hook (T4). Runs once after the steps, only if the run finished without a cancel or
 * an unexpected error. It journals its own sends and records receipts through `record`.
 */
export type Compensator = (ctx: CompensationContext) => Promise<void>;

export interface ExecutorDeps {
  store: ApplyStore;
  journal: JournalPort;
  providers: Partial<Record<Vendor, ProviderPort>>;
  /** Operational world tenant per vendor. */
  worlds: Partial<Record<Vendor, WorldContext>>;
  clock: Clock;
  policies: readonly BillingPolicy[];
  newId: (prefix: string) => string;
  guard?: StepGuard;
  compensate?: Compensator;
  /** Bounded in-run retries; see DEFAULT_RETRY. */
  retry?: Partial<RetryPolicy>;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Independent cases applied at once (default 1: one at a time). Cases that share a charge or
   * ticket, or depend on each other, always run in one sequential group.
   */
  caseConcurrency?: number;
  /**
   * Minimum age before a negative read permits an identical idempotency-protected replay.
   * Non-idempotent unknown writes remain held regardless of age. Default 60 s.
   */
  reconcileAfterMs?: number;
}

/** RunOutcome.refusal when another run of the same plan holds the apply lock: retry later. */
export const PLAN_LOCKED = "another run of this plan is applying";

/** RunOutcome.refusal when the run was cancelled before it was admitted. */
export const RUN_CANCELLED = "run was cancelled";

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
  /**
   * A read-only pass (cancelled or refused run) left a send of the plan unresolved, under any
   * revision: keep the run retryable so it is read again, bounded, rather than treating it as done.
   */
  unresolved?: boolean;
}

const RESULT_PATHS: ReadonlySet<string> = new Set(ResultPath.options);

export function vendorOf(action: Action): Vendor {
  if (action.kind.startsWith("stripe.")) return "stripe";
  return action.kind.startsWith("slack.") ? "slack" : "zendesk";
}

type SummaryStep = Extract<Action, { kind: "slack.message.postSummary" }>;

/** A run summary: it runs after every other step has settled and counts their outcomes. */
export function isSummary(action: Action): action is SummaryStep {
  return action.kind === "slack.message.postSummary";
}

/**
 * A money step's read effect is the exact approved one: the refund of that charge, or the credit
 * to that customer naming that charge, for that amount and currency. Other steps aren't checked.
 */
function effectMatches(action: Action, effect: Record<string, unknown>): boolean {
  if (action.kind === "stripe.refund.create") return refundEffectMatches(action, effect);
  if (action.kind === "stripe.customer.balanceCredit") return creditEffectMatches(action, effect);
  return true;
}

function targetOf(action: Action): EntityRef {
  switch (action.kind) {
    case "stripe.refund.create":
      return { vendor: "stripe", kind: "charge", id: action.args.chargeId };
    case "stripe.customer.balanceCredit":
      return { vendor: "stripe", kind: "customer", id: action.args.customerId };
    case "zendesk.ticket.patchFields":
    case "zendesk.ticket.appendPrivateNote":
    case "zendesk.ticket.appendPublicReply":
      return { vendor: "zendesk", kind: "ticket", id: action.args.ticketId };
    case "slack.message.postSummary":
      return { vendor: "slack", kind: "channel", id: action.args.channelId };
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

/** The key of an action's compensating undo: its own operation, stable across revisions. */
export function undoKey(orgId: string, planId: string, action: Action): string {
  return `op_${fingerprint({ undo: operationKey(orgId, planId, action) })}`;
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
    const b = body as {
      id?: unknown;
      status?: unknown;
      amount?: unknown;
      charge?: unknown;
      currency?: unknown;
    };
    if (typeof b?.id !== "string" || typeof b.amount !== "number" || typeof b.status !== "string") {
      throw new Error("refund response is missing id, status or amount");
    }
    const results = { "refund.id": b.id, "refund.status": b.status, "refund.amount": b.amount };
    const observed = { ...results, charge: b.charge, currency: b.currency };
    if (!refundEffectMatches(action, observed))
      throw new Error("refund does not match the approved successful effect");
    return {
      providerRef: { vendor: "stripe", kind: "refund", id: b.id },
      results,
      observed,
    };
  }
  if (action.kind === "stripe.customer.balanceCredit") {
    const b = body as {
      id?: unknown;
      amount?: unknown;
      currency?: unknown;
      customer?: unknown;
      type?: unknown;
      metadata?: { charge?: unknown } | null;
    } | null;
    if (typeof b?.id !== "string" || typeof b.amount !== "number") {
      throw new Error("balance transaction response is missing id or amount");
    }
    const observed = {
      "credit.id": b.id,
      "credit.amount": b.amount,
      "credit.type": b.type,
      "credit.charge": b.metadata?.charge ?? "",
      customer: b.customer,
      currency: b.currency,
    };
    if (!creditEffectMatches(action, observed))
      throw new Error("balance credit does not match the approved effect");
    return {
      providerRef: { vendor: "stripe", kind: "customer_balance_transaction", id: b.id },
      results: {},
      observed,
    };
  }
  if (isSummary(action)) {
    const b = body as { ok?: unknown; ts?: unknown; channel?: unknown } | null;
    if (b?.ok !== true || typeof b.ts !== "string") throw new Error("Slack response has no ts");
    return {
      providerRef: { vendor: "slack", kind: "message", id: b.ts },
      results: {},
      observed: { "message.ts": b.ts, channel: b.channel },
    };
  }
  const ticket = (body as { ticket?: Record<string, unknown> } | null)?.ticket;
  if (!ticket || typeof ticket !== "object") throw new Error("ticket response has no ticket");
  if (
    String(ticket.id) !== action.args.ticketId ||
    !ZendeskPriority.nullable().safeParse(ticket.priority).success ||
    !ZendeskStatus.safeParse(ticket.status).success ||
    (action.kind === "zendesk.ticket.patchFields" &&
      Object.entries(action.args.set).some(
        ([field, value]) => value !== undefined && ticket[field] !== value,
      ))
  ) {
    throw new Error("ticket response does not match the approved write");
  }
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

/**
 * Partition a plan's actions into groups that may run concurrently. Cases are joined into one
 * sequential group when they touch any record in common: a record one writes, a record any of
 * them cites as evidence, a customer or requester their queries cover, or a cross-case dependency.
 * So one case's write can never look like outside drift to another case's guard, and two writes to
 * one record never run side by side. Inside a group actions keep their topological order.
 */
export function caseGroups(
  manifest: Pick<PlanManifest, "actions" | "observations" | "queryObservations">,
): Action[][] {
  const { actions } = manifest;
  const parent = new Map<string, string>();
  const find = (c: string): string => {
    const p = parent.get(c) ?? c;
    if (p === c) return c;
    const root = find(p);
    parent.set(c, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const observations = new Map(manifest.observations.map((o) => [o.id, o]));
  const queries = new Map(manifest.queryObservations.map((q) => [q.id, q]));
  const caseOf = new Map(actions.map((a) => [a.id, a.caseId]));
  const firstCaseFor = new Map<string, string>();
  const touch = (key: string, caseId: string) => {
    const first = firstCaseFor.get(key);
    if (first) union(first, caseId);
    else firstCaseFor.set(key, caseId);
  };
  for (const a of actions) {
    if (!parent.has(a.caseId)) parent.set(a.caseId, a.caseId);
    const t = targetOf(a);
    touch(`record:${t.vendor}:${t.kind}:${t.id}`, a.caseId);
    for (const id of a.evidence) {
      const o = observations.get(id);
      // Unknown evidence can't be placed: keep that case with every other such case.
      touch(o ? `record:${o.entity.vendor}:${o.entity.kind}:${o.entity.id}` : "unplaced", a.caseId);
    }
    for (const id of a.queryEvidence) {
      const q = queries.get(id)?.predicate;
      const who =
        q?.kind === "stripe.charges.byCustomerInWindow"
          ? `customer:${q.customerId}`
          : q?.kind === "zendesk.tickets.byRequester"
            ? `requester:${q.requesterId}`
            : "unplaced";
      touch(who, a.caseId);
    }
    for (const d of a.dependsOn) {
      const other = caseOf.get(d);
      if (other) union(other, a.caseId);
    }
  }
  const groups = new Map<string, Action[]>();
  for (const a of topoOrder(actions)) {
    const root = find(a.caseId);
    groups.set(root, [...(groups.get(root) ?? []), a]);
  }
  return [...groups.values()];
}

/** Run-level admission. Any failure means nothing is dispatched. */
async function admit(
  job: ApplyJobInput,
  deps: ExecutorDeps,
  /** Read-only reconcile of a cancelled run: the plan must be trusted, the grant need not be live. */
  readOnly = false,
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
  // Before the read-only exit: even a read must go to the operational world, never planning.
  for (const [vendor, ctx] of Object.entries(deps.worlds)) {
    if (ctx && ctx.world !== manifest.target.environment) {
      return {
        ok: false,
        detail: `${vendor} is configured for the ${ctx.world} world, not operational`,
      };
    }
  }

  // A read-only pass resolves what the wired vendors can read; it never needs the rest.
  if (readOnly) return { ok: true, manifest, grant };
  // Every vendor the plan writes to must be wired, or the run would stop halfway (say, a summary
  // with no Slack provider after the refunds went out).
  const unwired = [...new Set(manifest.actions.map(vendorOf))].filter(
    (v) => !deps.providers[v] || !deps.worlds[v],
  );
  if (unwired.length > 0) {
    return { ok: false, detail: `no operational provider for ${unwired.join(", ")}` };
  }

  // A public reply must be exactly what its template renders, checked before any step runs; at
  // send time the refund it announces would already be out.
  for (const action of manifest.actions) {
    if (action.kind !== "zendesk.ticket.appendPublicReply") continue;
    try {
      replyBodyFor(action);
    } catch (err) {
      return { ok: false, detail: `${action.id}: ${(err as Error).message}` };
    }
  }

  if (grant.revokedAt !== null) return { ok: false, detail: "grant was revoked" };
  const grantedAt = Date.parse(grant.grantedAt);
  const expiresAt = Date.parse(grant.expiresAt);
  if (Number.isNaN(grantedAt) || Number.isNaN(expiresAt)) {
    return { ok: false, detail: "grant timestamps are unreadable" };
  }
  if (grantedAt > now) return { ok: false, detail: "grant is dated in the future" };
  if (expiresAt <= now) return { ok: false, detail: "grant expired" };
  if (requiresDualApproval(manifest, deps.policies)) {
    // Two live grants from two different users replace the single grant holding every role.
    if (!deps.store.loadGrantsForPlanHash) {
      return { ok: false, detail: "this plan needs two approvers and the store can't list grants" };
    }
    const all = await deps.store.loadGrantsForPlanHash(job.orgId, job.planHash);
    const status = dualApprovalStatus(
      liveGrantsFor(all, { ...manifest, planHash: job.planHash }, deps.clock.now()),
    );
    if (!status.satisfied) return { ok: false, detail: explainShortfall(status) };
  } else {
    const missing = [...new Set(manifest.actions.map((a) => a.requiredRole))].filter(
      (r) => !grant.roles.includes(r),
    );
    if (missing.length > 0) {
      return { ok: false, detail: `grant lacks roles: ${missing.join(", ")}` };
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
  // Lock first: a stale or overlapping delivery must defer to the run in progress, not reach a
  // refusal (say, a grant that expired meanwhile) and report a definite "failed" while it sends.
  const release = await deps.store.lockPlan(job.orgId, job.planId);
  if (!release) {
    const detail = PLAN_LOCKED;
    await journal.appendEvent(job.runId, "run.deferred", { detail });
    return { state: "held", receipts: [], refusal: detail, error: null };
  }
  try {
    if (await deps.store.runCancelled?.(job.orgId, job.runId)) {
      // Cancelled: nothing more is sent, but an earlier send whose outcome is unknown (say the
      // worker died after dispatch) is still resolved by reading, so no effect hides unrecorded.
      await journal.appendEvent(job.runId, "run.cancelled", { before: "admission" });
      const readable = await admit(job, deps, true);
      if (!readable.ok) {
        return { state: "cancelled", receipts: [], refusal: RUN_CANCELLED, error: null };
      }
      const outcome = await applyLocked(job, deps, readable.manifest, readable.grant, true);
      return { ...outcome, state: "cancelled", refusal: RUN_CANCELLED };
    }
    const admission = await admit(job, deps);
    if (!admission.ok) {
      await journal.appendEvent(job.runId, "run.refused", { detail: admission.detail });
      const refused = { state: "failed" as const, receipts: [], refusal: admission.detail };
      // Refused (say, the grant expired after a send): nothing new is sent and nothing is replayed,
      // but an earlier send whose outcome is unknown is still read back against the stored,
      // hash-checked plan, so a landed effect never stays without a receipt.
      const readable = await admit(job, deps, true);
      if (!readable.ok || !(await hasInFlight(job, deps, readable.manifest))) {
        return { ...refused, error: null };
      }
      const outcome = await applyLocked(
        job,
        deps,
        readable.manifest,
        readable.grant,
        true,
        "failed",
      );
      return {
        ...refused,
        receipts: outcome.receipts,
        error: outcome.error,
        unresolved: outcome.unresolved,
      };
    }
    return await applyLocked(job, deps, admission.manifest, admission.grant);
  } finally {
    await release();
  }
}

/** Any send of this plan (forward or undo, any revision) still in flight: dispatched or unknown. */
async function hasInFlight(
  job: ApplyJobInput,
  deps: ExecutorDeps,
  manifest: PlanManifest,
): Promise<boolean> {
  for (const action of manifest.actions) {
    const keys = [operationKey(job.orgId, job.planId, action)];
    if (action.kind === "zendesk.ticket.patchFields")
      keys.push(undoKey(job.orgId, job.planId, action));
    for (const key of keys) {
      const attempts = await deps.journal.attemptsForKey(key);
      if (attempts.some((a) => a.state === "dispatched" || a.state === "unknown_outcome"))
        return true;
    }
  }
  return false;
}

async function applyLocked(
  job: ApplyJobInput,
  deps: ExecutorDeps,
  manifest: PlanManifest,
  grant: ApprovalGrant,
  /** Only resolve in-flight attempts through reads; never send, adopt, guard or hold new work. */
  reconcileOnly = false,
  /** The state a read-only pass of a refused run reports (it never runs the plan). */
  refusedAs?: RunState,
): Promise<RunOutcome> {
  const { journal, clock } = deps;
  const at = () => clock.now().toISOString();
  const admittedGrantFingerprint = fingerprint(grant);
  // A read-only pass (cancelled or refused run) is not an admission: say what it is.
  await journal.appendEvent(job.runId, reconcileOnly ? "run.reconciling" : "run.admitted", {
    planHash: job.planHash,
    approvalId: grant.id,
  });

  const receipts: Receipt[] = [];
  /**
   * The journal's latest receipt per action, when this run wrote it: on an earlier delivery that
   * stopped on an error (since the run last finished), or earlier in this pass. A settle that
   * would record the same thing again (outcome, hold reason, provider object) adds no receipt.
   * Anchored to the journal, so a lost event or another run's newer receipt never hides a change;
   * a new run of the hash still writes its own.
   */
  const ownEarlier = new Map<string, Receipt>();
  const ownIds = new Set(((await journal.runReceipts?.(job.runId)) ?? []).map((r) => r.id));
  if (ownIds.size > 0) {
    const latest = new Map((await journal.receiptsFor(job.planHash)).map((r) => [r.actionId, r]));
    for (const [actionId, r] of latest) if (ownIds.has(r.id)) ownEarlier.set(actionId, r);
  }
  const gist = (r: Receipt) =>
    fingerprint({ outcome: r.outcome, holdReason: r.holdReason, providerRef: r.providerRef });
  const settled = new Map<string, ReceiptOutcome>();
  /** Set once a cancel is seen; no further action is admitted or sent. */
  let cancelled = false;
  /** Set on an unexpected failure in any lane: no lane starts another action or send. */
  let stopped = false;
  const checkCancelled = async (where: string) => {
    if (cancelled) return true;
    if (await deps.store.runCancelled?.(job.orgId, job.runId)) {
      cancelled = true;
      await journal.appendEvent(job.runId, "run.cancelled", { before: where }).catch(() => {});
    }
    return cancelled;
  };
  const grantStillValid = async () => {
    const current = await deps.store.loadGrant(job.orgId, grant.id);
    return (
      current !== null &&
      fingerprint(current) === admittedGrantFingerprint &&
      current.revokedAt === null &&
      Date.parse(current.expiresAt) > clock.now().getTime()
    );
  };
  /** Latest confirmed receipt per action for this hash (earlier runs included), never duplicated. */
  const confirmedByAction = new Map<string, Receipt>();
  /** Attempts this hash already holds as unresolved; a reconcile-only pass doesn't re-hold them. */
  const heldUnresolved = new Set<string>();
  /**
   * The compensation result this hash already recorded per action: any receipt after the action's
   * confirmed one, or one copied from an undo. Final for this hash; never settled again.
   */
  const compensationHere = new Map<string, Receipt>();
  /** Actions whose outcome in this run comes from compensation or a copied undo. */
  const compensated = new Set<string>();
  for (const r of await journal.receiptsFor(job.planHash)) {
    if (r.outcome === "confirmed") confirmedByAction.set(r.actionId, r);
    else if (
      (confirmedByAction.has(r.actionId) || typeof r.observedEffect.undoAttemptId === "string") &&
      // A lost undo is held until a read settles it, so that hold is not final.
      !(r.outcome === "held" && r.holdReason?.kind === "unresolved_outcome")
    ) {
      compensationHere.set(r.actionId, r);
      compensated.add(r.actionId);
    }
    if (r.outcome === "held" && r.holdReason?.kind === "unresolved_outcome") {
      heldUnresolved.add(r.holdReason.attemptId);
    }
  }
  /**
   * Attempts marked dispatched (or left unknown) whose step hasn't settled yet, across every case
   * running at once. Non-empty at the end means the run can't honestly be called failed.
   */
  const inFlightAttempts = new Set<string>();
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
    const earlier = ownEarlier.get(action.id);
    if (
      earlier &&
      receipt.outcome !== "confirmed" &&
      !opts.transitions?.length &&
      !opts.transition &&
      newBindings.length === 0 &&
      gist(earlier) === gist(receipt)
    ) {
      // An earlier pass of this run already recorded this; repeating it adds nothing.
      receipts.push(earlier);
      settled.set(action.id, earlier.outcome);
      return;
    }
    await journal.settle({
      transitions: opts.transitions,
      transition: opts.transition,
      bindings: newBindings,
      receipt,
    });
    ownEarlier.set(action.id, receipt);
    // The journal is the record: reflect it in memory before anything else can fail.
    for (const b of newBindings) bindings.set(bindingKey(b.ref), b.value);
    receipts.push(receipt);
    if (receipt.outcome === "confirmed") confirmedByAction.set(receipt.actionId, receipt);
    settled.set(action.id, receipt.outcome);
    for (const t of [...(opts.transitions ?? []), ...(opts.transition ? [opts.transition] : [])]) {
      inFlightAttempts.delete(t.attemptId);
    }
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
   * the attempts were closed as rejected (no status), so the step may be sent. With `noReplay`
   * (a cancelled run, or a dependent whose predecessor was undone) a negative read never permits
   * a send: the attempts stay in flight and the step is held.
   */
  async function reconcileInFlight(
    action: Action,
    key: string,
    inFlight: Attempt[],
    provider: ProviderPort,
    world: WorldContext,
    sameAsNewest: boolean,
    noReplay: boolean,
  ): Promise<"settled" | "resend"> {
    const newest = inFlight.at(-1) as Attempt;
    let result: ReconcileResult;
    try {
      result = await provider.reconcile(newest, action, world);
      if (sameAsNewest && result.kind === "applied" && !effectMatches(action, result.effect)) {
        result = {
          kind: "indeterminate",
          detail: "refund read does not match the approved successful effect",
        };
      }
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
    // A cancelled run never replays, so the replay that makes "not applied" safe to act on never
    // comes: keep the attempts in flight (a late landing is still found later) and hold. Nor does
    // a dependent whose predecessor was undone: idempotency stops a duplicate, not a send that
    // the undone predecessor no longer supports.
    if (
      !noReplay &&
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
    const heldAttempt = inFlight[0]?.id ?? newest.id;
    if (noReplay && heldUnresolved.has(heldAttempt)) {
      // Already held for this exact attempt: a repeated pass adds no duplicate receipt.
      settled.set(action.id, "held");
      return "settled";
    }
    await hold(action, { kind: "unresolved_outcome", attemptId: heldAttempt });
    return "settled";
  }

  /** A compensation receipt that settled an undo. A lost response is still waiting on a read. */
  const settledUndoReceipt = (r: Receipt | undefined): r is Receipt =>
    r?.outcome === "compensated" ||
    r?.outcome === "compensation_conflict" ||
    (r?.outcome === "held" && r.holdReason?.kind !== "unresolved_outcome");
  /**
   * The latest undo of this patch ever sent, under any revision, with the receipt compensation
   * settled it with. A prepared row had no effect. Neither had a refused undo left without a
   * receipt (a crash between 409 rounds): it counts as never sent, so compensation runs again.
   * `read` means the undo was sent and no receipt has settled it, so the ticket has to be read.
   */
  /** What the step guard sees: own confirmed writes, and for a remedy, every other remedy attempt. */
  const guardContext = async (action: Action): Promise<StepGuardContext> => {
    const context = { manifest, confirmedReceipts: [...confirmedByAction.values()] };
    const remedy = remedyOf(action);
    if (!remedy || !deps.store.remedyStepsFor) return context;
    const own = operationKey(job.orgId, job.planId, action);
    const priorRemedies: PriorRemedy[] = [];
    for (const step of await deps.store.remedyStepsFor(job.orgId, remedy.obligationId)) {
      for (const attempt of await journal.attemptsFor(step.planHash, step.actionId)) {
        // The same operation under another revision is this step's own write, not a second remedy.
        if (attempt.operationKey === own) continue;
        priorRemedies.push({ ...step, attemptId: attempt.id, state: attempt.state });
      }
    }
    return { ...context, priorRemedies };
  };

  const sentUndo = async (action: Action) => {
    if (action.kind !== "zendesk.ticket.patchFields") return undefined;
    const attempt = (await journal.attemptsForKey(undoKey(job.orgId, job.planId, action)))
      .filter((a) => a.state !== "prepared")
      .at(-1);
    if (!attempt) return undefined;
    let receipt: Receipt | undefined;
    for (const hash of new Set([attempt.planHash, job.planHash])) {
      const last = (await journal.receiptsFor(hash)).filter((r) => r.actionId === action.id).at(-1);
      if (settledUndoReceipt(last)) receipt = last;
    }
    if (attempt.state === "rejected" && !receipt) return undefined;
    const read = !receipt && attempt.state !== "confirmed" && attempt.state !== "rejected";
    return { attempt, receipt, read };
  };
  /**
   * What a landed undo means for the fields it did not itself restore. A field it wrote back is
   * not a conflict. One that still holds our value and can't be written is a manual hold.
   */
  const landedVerdict = (
    action: Extract<Action, { kind: "zendesk.ticket.patchFields" }>,
    effect: Record<string, unknown>,
    sent: ReadonlySet<string>,
  ): Pick<Receipt, "outcome" | "holdReason" | "limitations"> & { retry?: boolean } => {
    const kept: string[] = [];
    const manual: string[] = [];
    for (const [field, written] of Object.entries(action.args.set)) {
      if (written === undefined || sent.has(field)) continue;
      if (effect[field] !== written) kept.push(`${field} = ${String(effect[field])}`);
      else if (typeof action.args.before[field as "priority" | "status"] !== "string")
        manual.push(field);
    }
    const again: string[] = [];
    for (const [field, written] of Object.entries(action.args.set)) {
      if (written === undefined || sent.has(field) || effect[field] !== written) continue;
      if (typeof action.args.before[field as "priority" | "status"] === "string") again.push(field);
    }
    if (again.length > 0) {
      return {
        outcome: "held",
        holdReason: {
          kind: "unsupported_protection",
          detail: `undo ${again.join(", ")} as well; it still holds our value`,
        },
        limitations: again.map((f) => `${f} still holds our value`),
        retry: true,
      };
    }
    if (manual.length > 0) {
      return {
        outcome: "held",
        holdReason: {
          kind: "unsupported_protection",
          detail: `undo ${manual.join(", ")} by hand; the original value was empty`,
        },
        limitations: manual.map(
          (f) => `${f} still holds our value but its before value can't be written`,
        ),
      };
    }
    if (kept.length > 0) {
      const restored = [...sent]
        .filter((field) => field === "priority" || field === "status")
        .sort()
        .flatMap((field) => {
          const before = action.args.before[field as "priority" | "status"];
          return typeof before === "string" ? [`restored ${field} to ${before}`] : [];
        });
      return {
        outcome: "compensation_conflict",
        holdReason: null,
        limitations: [...restored, ...kept.map((k) => `kept ${k}: changed by someone else`)],
      };
    }
    return { outcome: "compensated", holdReason: null, limitations: [] };
  };
  /** Read the ticket and ask whether this undo's own fields are there. */
  const readUndo = async (
    action: Extract<Action, { kind: "zendesk.ticket.patchFields" }>,
    undo: Attempt,
  ): Promise<
    | {
        kind: "applied";
        effect: Record<string, unknown>;
        providerRef: EntityRef;
        sent: Set<string>;
      }
    | { kind: "not_applied" }
    | { kind: "indeterminate"; detail: string }
  > => {
    const provider = deps.providers.zendesk;
    const world = deps.worlds.zendesk;
    if (!provider || !world) return { kind: "indeterminate", detail: "no zendesk provider" };
    let sent: {
      priority?: (typeof action.args.set)["priority"];
      status?: (typeof action.args.set)["status"];
    };
    try {
      const ticket =
        (JSON.parse(undo.request.body) as { ticket?: Record<string, unknown> }).ticket ?? {};
      sent = {};
      if (typeof ticket.priority === "string")
        sent.priority = ticket.priority as NonNullable<(typeof sent)["priority"]>;
      if (typeof ticket.status === "string")
        sent.status = ticket.status as NonNullable<(typeof sent)["status"]>;
      if (sent.priority === undefined && sent.status === undefined) {
        return { kind: "indeterminate", detail: "undo request has no fields" };
      }
    } catch {
      return { kind: "indeterminate", detail: "undo request is unreadable" };
    }
    try {
      const result = await provider.reconcile(
        undo,
        { ...action, args: { ...action.args, set: sent } },
        world,
      );
      if (result.kind !== "applied") return result;
      // The field values alone are not proof: someone else can set the before value. The undo
      // carries its operation marker in a private comment; a read has to find that too.
      const marked = await provider.reconcile(
        undo,
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
      if (marked.kind !== "applied") {
        return marked.kind === "not_applied"
          ? {
              kind: "indeterminate",
              detail: "restored value is on the ticket but this undo left no marker",
            }
          : marked;
      }
      return {
        kind: "applied",
        effect: result.effect,
        providerRef: result.providerRef,
        sent: new Set(Object.keys(sent)),
      };
    } catch (err) {
      return { kind: "indeterminate", detail: `reconcile read failed: ${(err as Error).message}` };
    }
  };
  /**
   * Our write may no longer be on the ticket, so the forward patch is never adopted as confirmed.
   * An unsettled undo is read: restored values are recorded, a stamp that never moved lets a
   * fresh undo be sent once the attempt is old enough, and anything else stays held.
   */
  const settleFromUndo = async (
    action: Action,
    {
      attempt: undo,
      receipt: prior,
      read,
    }: { attempt: Attempt; receipt: Receipt | undefined; read: boolean },
  ) => {
    // This hash already settled the undo. Copying the receipt again would duplicate it.
    if (prior?.planHash === job.planHash) {
      compensated.add(action.id);
      settled.set(action.id, prior.outcome);
      return;
    }
    const pointer = { undoAttemptId: undo.id };
    if (read && action.kind === "zendesk.ticket.patchFields") {
      const result = await readUndo(action, undo);
      if (result.kind === "applied") {
        const verdict = landedVerdict(action, result.effect, result.sent);
        // A field still holds our value: leave the undo open so compensation can revert it.
        if (!verdict.retry) {
          compensated.add(action.id);
          const transitions: SettleTransition[] = [];
          if (undo.state === "dispatched") {
            transitions.push({
              attemptId: undo.id,
              from: "dispatched",
              to: "unknown_outcome",
              patch: { error: "outcome unknown" },
            });
          }
          if (undo.state === "dispatched" || undo.state === "unknown_outcome") {
            transitions.push({
              attemptId: undo.id,
              from: "unknown_outcome",
              to: "reconciled",
              patch: { settledAt: at() },
            });
          }
          return settle(
            action,
            receiptFor(action, verdict.outcome, {
              providerRef: result.providerRef,
              observedEffect: { ...result.effect, ...pointer },
              holdReason: verdict.holdReason,
              limitations: [
                ...verdict.limitations,
                `outcome of undo attempt ${undo.id} found by reading the provider; not re-sent`,
              ],
            }),
            { transitions },
          );
        }
      }
      // Not proved landed. Dependents may only recover an earlier send; the attempt stays open
      // so a later read can still find it. Compensation sends a fresh undo once it is old enough.
      compensated.add(action.id);
      const alreadyHeld = (await journal.receiptsFor(job.planHash)).some(
        (r) =>
          r.actionId === action.id &&
          r.outcome === "held" &&
          r.holdReason?.kind === "unresolved_outcome" &&
          r.holdReason.attemptId === undo.id,
      );
      if (alreadyHeld) {
        settled.set(action.id, "held");
        return;
      }
      return settle(
        action,
        receiptFor(action, "held", {
          holdReason: { kind: "unresolved_outcome", attemptId: undo.id },
          observedEffect: pointer,
          limitations: [
            result.kind === "indeterminate" ? result.detail : "undo not visible yet; not re-sent",
          ],
        }),
      );
    }
    compensated.add(action.id);
    if (!prior) {
      return settle(
        action,
        receiptFor(action, "held", {
          holdReason: { kind: "unresolved_outcome", attemptId: undo.id },
          observedEffect: pointer,
          limitations: ["an undo of this patch has no settled outcome; not adopted"],
        }),
      );
    }
    return settle(
      action,
      receiptFor(action, prior.outcome, {
        providerRef: prior.providerRef,
        observedEffect: { ...prior.observedEffect, ...pointer },
        holdReason: prior.holdReason,
        limitations: [
          `compensated under plan hash ${undo.planHash}; not re-sent`,
          ...prior.limitations,
        ],
      }),
    );
  };

  /**
   * Read a just-confirmed write back from the provider (T3.8): the refund by its operation key,
   * the note by its marker, the patch's fields. `read` matches the approved effect; `contradicted`
   * means the provider's records don't show what it just confirmed; `inconclusive` means the read
   * couldn't tell (it failed, or someone else wrote the field since), so the write response stands.
   */
  const readBack = async (
    action: Action,
    attemptId: string,
    provider: ProviderPort,
    world: WorldContext,
    written: EntityRef,
  ): Promise<
    | { kind: "read"; effect: Record<string, unknown> }
    | { kind: "contradicted"; detail: string; read: Record<string, unknown> }
    | { kind: "inconclusive"; detail: string }
  > => {
    try {
      const attempt = (
        await journal.attemptsForKey(operationKey(job.orgId, job.planId, action))
      ).find((a) => a.id === attemptId);
      if (!attempt) return { kind: "inconclusive", detail: "attempt not found in the journal" };
      const result = await provider.reconcile(attempt, action, world);
      if (result.kind === "indeterminate") {
        return result.contradicts
          ? {
              kind: "contradicted",
              detail: `a read-back contradicts it: ${result.detail}`,
              read: {},
            }
          : { kind: "inconclusive", detail: result.detail };
      }
      if (result.kind === "not_applied") {
        return { kind: "contradicted", detail: "a read-back doesn't find the effect", read: {} };
      }
      if (
        (action.kind === "stripe.refund.create" ||
          action.kind === "stripe.customer.balanceCredit") &&
        (!effectMatches(action, result.effect) || result.providerRef.id !== written.id)
      ) {
        return {
          kind: "contradicted",
          detail: "the refund read back doesn't match the approved refund",
          read: result.effect,
        };
      }
      return { kind: "read", effect: result.effect };
    } catch (err) {
      return { kind: "inconclusive", detail: `read failed: ${(err as Error).message}` };
    }
  };

  /** Each outcome count of a summary, from this run's settled outcomes of the steps it lists. */
  const summaryCounts = (action: SummaryStep): [string, number][] =>
    Object.entries(action.args.bindings).flatMap(([name, b]): [string, number][] => {
      if (typeof b !== "object") return [];
      const counted = b.stepIds.filter((id) => {
        const outcome = settled.get(id);
        return outcome !== undefined && b.outcomes.includes(outcome);
      });
      return [[summaryCountKey(name), counted.length]];
    });

  /**
   * `recoveryFor` names an undone predecessor this action depends on: the action may only have its
   * earlier send recorded (confirmed by a read, or held), never a new one.
   */
  async function step(action: Action, recoveryFor?: string): Promise<void> {
    const compensation = compensationHere.get(action.id);
    if (compensation) {
      settled.set(action.id, compensation.outcome);
      return;
    }
    if (confirmedByAction.has(action.id)) {
      // Already confirmed (or adopted) for this hash in an earlier run; never settle it twice.
      const undo = await sentUndo(action);
      if (undo) return settleFromUndo(action, undo);
      settled.set(action.id, "confirmed");
      return;
    }
    const key = operationKey(job.orgId, job.planId, action);
    const vendor = vendorOf(action);
    const provider = deps.providers[vendor];
    const world = deps.worlds[vendor];
    if (!provider || !world) {
      // Only a read-only pass gets here (admission needs every vendor). A send to a vendor that is
      // no longer wired can't be read back: it stays in flight, reported unresolved.
      if (reconcileOnly) return;
      throw new Error(`no operational provider configured for ${vendor}`);
    }

    const refs = resultRefsOf(action);
    const unresolved = refs.find((r) => !bindings.has(bindingKey(r)));
    const resolved: ResolvedBindings = new Map([
      ...refs.map((r): [string, string | number] => [
        bindingKey(r),
        bindings.get(bindingKey(r)) as string | number,
      ]),
      ...(isSummary(action) ? summaryCounts(action) : []),
    ]);

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
      // Under one plan hash a summary's template and literals are fixed; only its counts can
      // differ, and they are what that send counted then. It is the same post.
      if (isSummary(action) && a.planHash === job.planHash) return true;
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
      const outcome = await reconcileInFlight(
        action,
        key,
        inFlight,
        provider,
        world,
        sameAsNewest,
        reconcileOnly || recoveryFor !== undefined,
      );
      if (outcome === "settled") return;
      if (reconcileOnly) return; // no effect was found; a cancelled run sends nothing new
      prior = await journal.attemptsForKey(key); // read showed no effect: the step may be sent
    }
    if (reconcileOnly) {
      // Nothing of this step's own is in flight, but an undo of it may be: say a newer revision
      // that never applied this patch itself, refused or cancelled after an older revision's undo
      // lost its response. Read that undo back too. `settleFromUndo` only reads, records or holds.
      // Only an undo of this same content: one of a patch a revision changed was never this
      // action's write, so judging it by this action's fields would record something false.
      const sent = prior.filter((a) => a.state !== "prepared").at(-1);
      if (!sent || !sameContent(sent)) return;
      const undo = await sentUndo(action);
      if (undo?.read) return settleFromUndo(action, undo);
      return;
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
      const undo = await sentUndo(action);
      if (undo) return settleFromUndo(action, undo);
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
      if (back.kind !== "applied" || !effectMatches(action, back.effect)) {
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
      const undo = await sentUndo(action);
      if (undo) return settleFromUndo(action, undo);
      // An earlier revision's write whose read-back contradicted it has no confirmed receipt (and
      // no bindings), and neither does one whose recorded effect isn't this action's: read it back
      // now rather than adopt it (T3.8).
      const confirmedEarlier = (await journal.receiptsFor(latest.planHash)).find(
        (r) =>
          r.actionId === action.id &&
          r.outcome === "confirmed" &&
          effectMatches(action, r.observedEffect),
      );
      if (!confirmedEarlier) {
        let back: ReconcileResult;
        try {
          back = await provider.reconcile(latest, action, world);
        } catch (err) {
          back = { kind: "indeterminate", detail: (err as Error).message };
        }
        if (back.kind !== "applied" || !effectMatches(action, back.effect)) {
          return hold(action, { kind: "unresolved_outcome", attemptId: latest.id });
        }
        return settle(
          action,
          receiptFor(action, "confirmed", {
            providerRef: back.providerRef,
            observedEffect: back.effect,
            limitations: [
              `applied by attempt ${latest.id} under plan hash ${latest.planHash}; read back, not re-sent`,
            ],
          }),
          { results: bindable(back.effect) },
        );
      }
      // Confirmed under an earlier revision of this plan with the same content: adopt that receipt's
      // provider object and observed effect (a credit's balance transaction has no bindings), and
      // its bindings for later steps.
      const earlier = (await journal.bindings(latest.planHash)).filter(
        (b) => b.ref.stepId === latest.actionId,
      );
      const results = Object.fromEntries(earlier.map((b) => [b.ref.path, b.value]));
      return settle(
        action,
        receiptFor(action, "confirmed", {
          providerRef: confirmedEarlier.providerRef ?? targetOf(action),
          observedEffect: confirmedEarlier.observedEffect,
          limitations: [
            `applied by attempt ${latest.id} under plan hash ${latest.planHash}; not re-sent`,
          ],
        }),
        { results },
      );
    }

    if (recoveryFor !== undefined) {
      // Nothing earlier took effect to record, and the predecessor this send needs was undone.
      return settle(
        action,
        receiptFor(action, "skipped_dependency", {
          holdReason: { kind: "predecessor_not_confirmed", stepId: recoveryFor },
        }),
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
    const guardHold = deps.guard ? await deps.guard(action, await guardContext(action)) : null;
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
    const replayGuard = async (step: Action, unknownId: string): Promise<HoldReason | null> => {
      const attempt = (await journal.attemptsForKey(key)).find((a) => a.id === unknownId);
      let read: ReconcileResult;
      try {
        read = attempt
          ? await provider.reconcile(attempt, step, world)
          : { kind: "indeterminate", detail: "unknown attempt not in the journal" };
      } catch (err) {
        read = { kind: "indeterminate", detail: (err as Error).message };
      }
      if (read.kind === "applied" && effectMatches(step, read.effect)) {
        return null;
      }
      return deps.guard ? deps.guard(step, await guardContext(step)) : null;
    };

    for (let n = 1; ; n++) {
      // A definite refusal did nothing. Revalidate before another fresh send after backoff.
      // Unknown sends use only an identical provider-idempotent replay: our earlier effect
      // may already be visible and must be resolved rather than mistaken for external drift.
      if (n > 1 && unknownSends.length === 0 && deps.guard) {
        const reason = await deps.guard(action, await guardContext(action));
        if (reason) return hold(action, reason);
      }
      // A replay is only safe without the guard when our earlier send landed. If the read can't
      // show that, the replay may be the first send to apply, so the world gets re-checked first
      // (a teammate may have credited the customer during the backoff).
      if (n > 1 && unknownSends.length > 0 && deps.guard) {
        const reason = await replayGuard(action, unknownSends.at(-1) as string);
        if (reason) {
          return settle(
            action,
            receiptFor(action, "unknown_outcome", {
              holdReason: reason,
              limitations: [
                ...retried(n - 1),
                "earlier send outcome remains unknown; the re-check held it, so it was not re-sent",
              ],
            }),
          );
        }
      }
      // A cancel stops the next send, including a retry. An earlier send of this step whose
      // outcome is unknown stays unknown (it is reconciled by a later run, never re-sent here).
      // Another lane hit an unexpected error: send nothing more here either.
      if (stopped || (await checkCancelled(`send ${action.id}`))) {
        if (unknownSends.length > 0) {
          return settle(
            action,
            receiptFor(action, "unknown_outcome", {
              holdReason: { kind: "unresolved_outcome", attemptId: unknownSends[0] as string },
              limitations: [
                cancelled
                  ? "run cancelled; earlier send outcome remains unknown"
                  : "run stopped on an error in another case; earlier send outcome remains unknown",
              ],
            }),
          );
        }
        return;
      }
      // Admission is not a lease to keep spending after revocation or expiry. Re-read the
      // same immutable grant before every send, including a retry after backoff.
      if (!(await grantStillValid())) {
        const reason: HoldReason = {
          kind: "approval_invalid",
          detail: "approval changed, was revoked, or expired before dispatch",
        };
        if (unknownSends.length > 0) {
          return settle(
            action,
            receiptFor(action, "unknown_outcome", {
              holdReason: reason,
              limitations: ["earlier send outcome remains unknown; no further request was sent"],
            }),
          );
        }
        return hold(action, reason);
      }
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
      inFlightAttempts.add(current);

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
          const transition: SettleTransition = {
            attemptId: current,
            from: "dispatched",
            to: "confirmed",
            patch: { providerStatus: result.status, settledAt: at() },
          };
          const replayed = unknownSends.map((id) => ({
            attemptId: id,
            from: "unknown_outcome" as const,
            to: "reconciled" as const,
            patch: { settledAt: at() },
          }));
          // Read the effect back before the receipt is final (T3.8).
          const back = await readBack(action, current, provider, world, providerRef);
          if (back.kind === "contradicted") {
            // The provider said it worked, but its own records don't show it. Neither side is
            // assumed: the step is held (dependents wait), nothing is bound, and a later run reads
            // this confirmed attempt back again before it ever counts.
            return settle(
              action,
              receiptFor(action, "held", {
                providerRef,
                observedEffect: { written: observed, read: back.read },
                holdReason: { kind: "unresolved_outcome", attemptId: current },
                limitations: [
                  `the provider confirmed the write, but ${back.detail}`,
                  ...retried(n),
                ],
              }),
              { transitions: replayed, transition },
            );
          }
          return settle(
            action,
            receiptFor(action, "confirmed", {
              providerRef,
              observedEffect: back.kind === "read" ? { ...observed, ...back.effect } : observed,
              limitations: [
                back.kind === "read"
                  ? "read back from the provider after the write"
                  : `effect taken from the write response; read-back inconclusive: ${back.detail}`,
                ...retried(n),
              ],
            }),
            // The replay answered for the earlier unknown sends of the same bytes and key.
            { transitions: replayed, transition, results },
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
          // This send had no effect. An earlier unknown send stays in flight until it settles.
          inFlightAttempts.delete(current);
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

  /**
   * Took effect, or may have, under any revision: `step()` confirms it, or reconciles a lost
   * response by a read. A prepared or refused attempt wrote nothing, so it doesn't count.
   */
  const alreadySent = async (action: Action) =>
    confirmedByAction.has(action.id) ||
    (await journal.attemptsForKey(operationKey(job.orgId, job.planId, action))).some(
      (a) => a.state !== "prepared" && a.state !== "rejected",
    );

  /** One action, with the dependency, cancel and error handling every case shares. */
  async function runAction(action: Action): Promise<"next" | "stop"> {
    // A summary counts what happened to its steps, so any settled outcome lets it run.
    const ready = (d: string) =>
      isSummary(action) ? settled.has(d) : settled.get(d) === "confirmed";
    const blocked = action.dependsOn.find((d) => !ready(d));
    try {
      if (reconcileOnly) {
        // Only steps with an earlier send in flight have anything to resolve.
        await step(action);
        return "next";
      }
      if (await checkCancelled(`step ${action.id}`)) return "stop";
      // An action already sent keeps its own record even if a predecessor was undone since.
      const onlyUndone = action.dependsOn.filter((d) => !ready(d)).every((d) => compensated.has(d));
      const recovering = blocked !== undefined && onlyUndone && (await alreadySent(action));
      if (blocked && !recovering) {
        await settle(
          action,
          receiptFor(action, "skipped_dependency", {
            holdReason: { kind: "predecessor_not_confirmed", stepId: blocked },
          }),
        );
        return "next";
      }
      // Past an undone predecessor, only an earlier send is resolved: nothing new is sent.
      await step(action, recovering ? blocked : undefined);
      return cancelled ? "stop" : "next";
    } catch (err) {
      // Unexpected failure (journal down, adapter bug). Stop: no further action starts in any
      // case, and anything already dispatched stays in the journal as dispatched, never re-sent.
      error ??= `${action.id}: ${(err as Error).message}`;
      await journal
        .appendEvent(job.runId, "step.error", {
          actionId: action.id,
          error: (err as Error).message,
        })
        .catch(() => {});
      return "stop";
    }
  }

  // Each group runs its actions in order; up to `caseConcurrency` groups run at once.
  const requested = deps.caseConcurrency ?? 1;
  const width = Number.isFinite(requested) ? Math.floor(requested) : 1;
  // Summaries run after the lanes and compensation, so they never join or hold up a case.
  const steps = manifest.actions.filter((a) => !isSummary(a));
  // One at a time keeps the exact global topological order; otherwise independent groups.
  const groups = width <= 1 ? [topoOrder(steps)] : caseGroups({ ...manifest, actions: steps });
  const limit = Math.max(1, Math.min(width, groups.length));
  let nextGroup = 0;
  const lane = async () => {
    while (!stopped && !cancelled) {
      const group = groups[nextGroup++];
      if (!group) return;
      for (const action of group) {
        if (stopped || cancelled) return;
        if ((await runAction(action)) === "stop") {
          if (!cancelled) stopped = true;
          return;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, lane));

  if (deps.compensate && !reconcileOnly && !cancelled && error === null) {
    try {
      await deps.compensate({
        orgId: job.orgId,
        planHash: job.planHash,
        manifest,
        outcomes: settled,
        receipts: await journal.receiptsFor(job.planHash),
        journal,
        newId: deps.newId,
        maySend: async () => !(await checkCancelled("compensation")) && (await grantStillValid()),
        record: (action, { outcome, transition, ...extra }) =>
          settle(action, receiptFor(action, outcome, extra), { transition }),
        reconcileAfterMs: deps.reconcileAfterMs ?? 60_000,
      });
    } catch (err) {
      error = `compensation: ${(err as Error).message}`;
      await journal.appendEvent(job.runId, "step.error", { error }).catch(() => {});
    }
  }

  // Last, once every step (and any undo) has settled: each summary reports what really happened.
  // A cancelled or failed run posts none; a read-only pass only resolves an earlier post.
  if (reconcileOnly || (!cancelled && !stopped && error === null)) {
    for (const action of topoOrder(manifest.actions).filter(isSummary)) {
      if ((await runAction(action)) === "stop") break;
    }
  }

  const outcomes = manifest.actions.map((a) => settled.get(a.id));
  const confirmed = outcomes.filter((o) => o === "confirmed").length;
  // A cancelled run reads "cancelled"; its receipts still show every effect that did happen.
  const state: RunState = refusedAs
    ? refusedAs
    : cancelled
      ? "cancelled"
      : confirmed === outcomes.length
        ? "completed"
        : confirmed > 0
          ? "partial"
          : inFlightAttempts.size > 0 ||
              outcomes.some((o) => o === "held" || o === "unknown_outcome")
            ? "held"
            : "failed";
  // A read-only pass (cancelled or refused run) that left a send of the plan unresolved, under
  // any revision, is retried too, so it is read again and, bounded, handed to an operator.
  const unresolved = reconcileOnly && (await hasInFlight(job, deps, manifest));
  // A run that stopped on an error isn't finished: the worker retries it.
  await journal
    .appendEvent(job.runId, error === null && !unresolved ? "run.finished" : "run.stopped", {
      state,
      error,
      ...(unresolved ? { unresolved } : {}),
    })
    .catch(() => {});
  return { state, receipts, refusal: null, error, ...(unresolved ? { unresolved } : {}) };
}
