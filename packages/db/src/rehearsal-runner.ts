import {
  type Attempt,
  type AttemptState,
  ExecutionRehearsalJob,
  type ExecutionRehearsalReport,
  type ObjectBinding,
  PlanManifest,
  type Receipt,
  type RehearsalEvidence,
  type RehearsalStepOutcome,
  type RehearsalStepResult,
  type RehearsalVerification,
  type RehearsalVersions,
  type RunEvent,
  type Vendor,
} from "@rehearsal/contracts";
import {
  type BillingPolicy,
  type ChallengeOperation,
  type Clock,
  type Compensator,
  challengeOperations,
  challengesDigest,
  planHash as computePlanHash,
  createCompensator,
  executeRehearsal,
  fingerprint,
  type JournalPort,
  lookupScenario,
  operationKey,
  type ProviderPort,
  type RetryPolicy,
  type RunOutcome,
  rehearsalOperationKey,
  resolveScenario,
  type SettleStep,
  type StepGuard,
  snapshotDigest,
  VERIFIER_VERSION,
  type WorldContext,
} from "@rehearsal/core";
import { and, eq } from "drizzle-orm";
import type { Db } from "./index";
import { isLegalTransition } from "./journal";
import {
  clearContainerSetDirty,
  DEFAULT_CONTAINER_SET,
  dirtyMarkOn,
  holdContainerSet,
  markContainerSetDirty,
} from "./rehearsal-sets";
import {
  loadRehearsal,
  markRehearsalTornDown,
  recordRehearsalStepResult,
  saveRehearsalReport,
  transitionRehearsal,
} from "./rehearsals";
import { planVersions, rehearsalAttempts } from "./schema";

/** The limitation a report carries when a send was still in flight as the run ended. */
export const IN_FLIGHT_KEPT =
  "a send's outcome was still unknown when the run ended: the tenant is kept and read again before teardown";

/** This rehearsal's sends still in flight (dispatched, or outcome unknown). A prepared one was never sent. */
export async function rehearsalInFlight(db: Db, orgId: string, rehearsalId: string) {
  const rows = await db
    .select({ id: rehearsalAttempts.id, state: rehearsalAttempts.state })
    .from(rehearsalAttempts)
    .where(and(eq(rehearsalAttempts.orgId, orgId), eq(rehearsalAttempts.rehearsalId, rehearsalId)));
  return rows.filter((r) => r.state === "dispatched" || r.state === "unknown_outcome");
}

/**
 * `passed` only when the run completed and every step was read as the scenario expects. A
 * mismatched read is `failed` even if another step could not be read. Anything unresolved,
 * including a step that never ran, stays `unknown`.
 */
function verdictFor(
  state: "completed" | "failed" | "cancelled",
  steps: ExecutionRehearsalReport["steps"],
): ExecutionRehearsalReport["verdict"] {
  if (steps.some((step) => step.verification.status === "mismatched")) return "failed";
  const unresolved =
    state !== "completed" ||
    steps.length === 0 ||
    steps.some(
      (step) =>
        step.result === null ||
        step.result.outcome === "unknown_outcome" ||
        step.verification.status !== "matched",
    );
  return unresolved ? "unknown" : "passed";
}

/** The report for a rehearsal that ended: one entry per stored step, from its latest receipt. */
export function rehearsalReport(
  job: Pick<ExecutionRehearsalJob, "rehearsalId" | "plan" | "scenario" | "snapshot" | "policy">,
  manifest: PlanManifest,
  receipts: readonly Receipt[],
  opts: {
    state: "completed" | "failed" | "cancelled";
    limitations: string[];
    notFromEvidence: string[];
    startedAt: string;
    finishedAt: string;
    versions: RehearsalVersions;
    evidence: RehearsalEvidence;
    /**
     * The verifier's judgment, keyed by action. Omitted, every step stays unverified: the sweeper
     * has no such reads once it is reporting a worker that already stopped, and a missing read
     * is not a pass.
     */
    verifications?: ReadonlyMap<string, RehearsalVerification>;
  },
): ExecutionRehearsalReport {
  const latest = new Map(receipts.map((x) => [x.actionId, x]));
  const listed = lookupScenario(job.scenario);
  const bound = listed ? resolveScenario(manifest, job.scenario) : { ok: false as const };
  const expectedOf = bound.ok
    ? new Map(bound.scenario.steps.map((step) => [step.actionId, step.outcome]))
    : null;
  const steps = manifest.actions.map((action) => {
    const receipt = latest.get(action.id);
    const result = receipt ? toStepResult(job, action, receipt) : null;
    const given = opts.verifications?.get(action.id);
    // A step with no receipt never ran. Nothing read about it counts as verified.
    const verification: RehearsalVerification = !result
      ? {
          status: "unverified",
          detail: opts.verifications
            ? "the step never ran, so it cannot be verified"
            : "the independent verifier (T4.12) has not read this step",
        }
      : (given ?? {
          status: "unverified",
          detail: opts.verifications
            ? "the independent verifier returned no read for this step"
            : "the independent verifier (T4.12) has not read this step",
        });
    return {
      actionId: action.id,
      expected: expectedOf?.get(action.id) ?? "confirmed",
      result,
      verification,
    };
  });
  const unread = steps.some((step) => step.verification.status === "unverified");
  return {
    world: "rehearsal",
    rehearsalId: job.rehearsalId,
    plan: job.plan,
    scenario: job.scenario,
    challengesDigest: listed ? challengesDigest(listed) : fingerprint([]),
    snapshot: job.snapshot,
    policy: job.policy,
    versions: opts.versions,
    evidence: opts.evidence,
    state: opts.state,
    verdict: verdictFor(opts.state, steps),
    steps,
    notFromEvidence: opts.notFromEvidence,
    limitations: [
      ...(opts.verifications
        ? unread
          ? ["an independent read could not establish every step"]
          : []
        : ["no independent verification yet (T4.12): the verdict stays unknown"]),
      ...opts.limitations,
    ],
    startedAt: opts.startedAt,
    finishedAt: opts.finishedAt,
  };
}

/**
 * T3.15: run one stored-plan execution rehearsal (decision 0013, §5) through T3.14's
 * `executeRehearsal`, in the rehearsal's own disposable worlds and journal.
 */

/**
 * The executor's journal for one rehearsal pass. A rehearsal is never resumed (decision 0013, §5),
 * so its working state (receipts, bindings, run events) lives in memory for the pass. Every attempt
 * is written through to `rehearsal_attempts` before it is sent, as the durable record of what was
 * journaled and dispatched; the step results and the report are stored at the end. It never
 * touches an operational table.
 */
export class RehearsalRunJournal implements JournalPort {
  readonly attempts = new Map<string, Attempt>();
  readonly receipts: Receipt[] = [];
  readonly events: RunEvent[] = [];
  readonly #bindings = new Map<string, ObjectBinding>();

  constructor(
    private readonly db: Db,
    private readonly orgId: string,
    private readonly rehearsalId: string,
  ) {}

  /**
   * The rehearsal's journal as its attempts left it, for a read-only pass after its worker stopped
   * (T3.16). Receipts and bindings lived in the dead worker's memory, so they start empty; the pass
   * only reads, so it can't send on the strength of a missing one.
   */
  static async load(db: Db, orgId: string, rehearsalId: string): Promise<RehearsalRunJournal> {
    const journal = new RehearsalRunJournal(db, orgId, rehearsalId);
    const rows = await db
      .select()
      .from(rehearsalAttempts)
      .where(
        and(eq(rehearsalAttempts.orgId, orgId), eq(rehearsalAttempts.rehearsalId, rehearsalId)),
      );
    for (const row of rows) {
      journal.attempts.set(row.id, {
        id: row.id,
        actionId: row.actionId,
        planHash: row.planHash,
        operationKey: row.operationKey,
        attemptNo: row.attemptNo,
        state: row.state as AttemptState,
        request: row.request as Attempt["request"],
        providerStatus: row.providerStatus,
        error: row.error,
        preparedAt: row.preparedAt.toISOString(),
        dispatchedAt: row.dispatchedAt?.toISOString() ?? null,
        settledAt: row.settledAt?.toISOString() ?? null,
      });
    }
    return journal;
  }

  async prepareAttempt(attempt: Attempt): Promise<void> {
    if (attempt.state !== "prepared") throw new Error("attempt must be inserted as prepared");
    for (const a of this.attempts.values()) {
      if (a.operationKey === attempt.operationKey && a.attemptNo === attempt.attemptNo) {
        throw new Error("duplicate operation key and attempt number");
      }
    }
    // The table's CHECK refuses any key not namespaced `rh_<rehearsalId>_`.
    await this.db.insert(rehearsalAttempts).values({
      id: attempt.id,
      orgId: this.orgId,
      rehearsalId: this.rehearsalId,
      planHash: attempt.planHash,
      actionId: attempt.actionId,
      operationKey: attempt.operationKey,
      attemptNo: attempt.attemptNo,
      state: attempt.state,
      request: attempt.request,
      providerStatus: attempt.providerStatus,
      error: attempt.error,
      preparedAt: new Date(attempt.preparedAt),
    });
    this.attempts.set(attempt.id, structuredClone(attempt));
  }

  async transition(
    attemptId: string,
    from: AttemptState,
    to: AttemptState,
    patch: Partial<Pick<Attempt, "providerStatus" | "error" | "dispatchedAt" | "settledAt">> = {},
  ): Promise<Attempt> {
    if (!isLegalTransition(from, to))
      throw new Error(`illegal attempt transition ${from} -> ${to}`);
    const current = this.attempts.get(attemptId);
    if (current?.state !== from) throw new Error(`attempt ${attemptId} is not in state ${from}`);
    const next = { ...current, ...patch, state: to };
    const updated = await this.db
      .update(rehearsalAttempts)
      .set({
        state: to,
        ...(patch.providerStatus !== undefined && { providerStatus: patch.providerStatus }),
        ...(patch.error !== undefined && { error: patch.error }),
        ...(patch.dispatchedAt && { dispatchedAt: new Date(patch.dispatchedAt) }),
        ...(patch.settledAt && { settledAt: new Date(patch.settledAt) }),
      })
      .where(
        and(
          eq(rehearsalAttempts.orgId, this.orgId),
          eq(rehearsalAttempts.id, attemptId),
          eq(rehearsalAttempts.state, from),
        ),
      )
      .returning({ id: rehearsalAttempts.id });
    if (updated.length !== 1) throw new Error(`attempt ${attemptId} is not in state ${from}`);
    this.attempts.set(attemptId, next);
    return next;
  }

  async attemptsFor(planHash: string, actionId: string): Promise<Attempt[]> {
    return [...this.attempts.values()]
      .filter((a) => a.planHash === planHash && a.actionId === actionId)
      .sort((a, b) => a.attemptNo - b.attemptNo);
  }

  async attemptsForKey(key: string): Promise<Attempt[]> {
    return [...this.attempts.values()]
      .filter((a) => a.operationKey === key)
      .sort((a, b) => a.attemptNo - b.attemptNo);
  }

  async settle(step: SettleStep): Promise<void> {
    for (const t of [...(step.transitions ?? []), ...(step.transition ? [step.transition] : [])]) {
      await this.transition(t.attemptId, t.from, t.to, t.patch);
    }
    for (const b of step.bindings) await this.bind(b);
    await this.recordReceipt(step.receipt);
  }

  async recordReceipt(receipt: Receipt): Promise<void> {
    this.receipts.push(structuredClone(receipt));
  }

  async receiptsFor(planHash: string): Promise<Receipt[]> {
    return this.receipts.filter((r) => r.planHash === planHash);
  }

  async bind(binding: ObjectBinding): Promise<void> {
    const key = `${binding.planHash}|${binding.ref.stepId}|${binding.ref.path}`;
    const existing = this.#bindings.get(key);
    if (existing && existing.value !== binding.value) {
      throw new Error(
        `binding ${binding.ref.stepId}:${binding.ref.path} already holds a different value`,
      );
    }
    this.#bindings.set(key, binding);
  }

  async bindings(planHash: string): Promise<ObjectBinding[]> {
    return [...this.#bindings.values()].filter((b) => b.planHash === planHash);
  }

  async appendEvent(runId: string, type: string, payload: unknown): Promise<RunEvent> {
    const event = {
      seq: this.events.length + 1,
      runId,
      type,
      at: new Date().toISOString(),
      payload: payload ?? {},
    };
    this.events.push(event);
    return event;
  }
}

/** What the operator did to seed the rehearsal's tenants (T1.22's `provisionSnapshot`). */
export type Provisioning =
  | { ok: true; notFromEvidence: string[] }
  | { ok: false; refusals: string[] };

export interface RehearsalRunContext {
  db: Db;
  /** Bound to this rehearsal's own tenants in the rehearsal containers, never another world. */
  providers: Partial<Record<Vendor, ProviderPort>>;
  worlds: Partial<Record<Vendor, WorldContext>>;
  clock: Clock;
  policies: readonly BillingPolicy[];
  newId: (prefix: string) => string;
  versions: RehearsalVersions;
  evidence: RehearsalEvidence;
  /** Operator side (decision 0013, §3): check the snapshot, reset the tenants and inject it. */
  provision: (manifest: PlanManifest, rehearsalId: string) => Promise<Provisioning>;
  /** Operator side: reset the rehearsal's tenants once it has ended. Idempotent. */
  teardown: (rehearsalId: string, state: "completed" | "failed" | "cancelled") => Promise<void>;
  /**
   * Independent reads of this rehearsal's tenant (T4.12), called after the run has stopped
   * sending and before teardown. Absent, the report stays unverified and cannot pass. A throw
   * is a failed read, not a match.
   */
  verify?: (input: {
    manifest: PlanManifest;
    job: Pick<ExecutionRehearsalJob, "rehearsalId" | "plan" | "scenario" | "snapshot">;
    results: readonly { actionId: string; outcome: RehearsalStepOutcome }[];
  }) => Promise<ReadonlyMap<string, RehearsalVerification>>;
  compensate?: Compensator;
  retry?: Partial<RetryPolicy>;
  sleep?: (ms: number) => Promise<void>;
  /**
   * T3.16, operator side: apply a resolved, allowlisted challenge to this rehearsal's tenant
   * (inject before the run, the teammate edit after a named step is rejected). The worker can't
   * call `/_admin`, so this goes through the API. Absent, a scenario that needs it fails closed.
   */
  challenge?: (input: {
    rehearsalId: string;
    phase: "before_run" | "after_rejected";
    actionId?: string;
  }) => Promise<{ applied: string[] }>;
  /** Re-reads each write's evidence in the rehearsal's tenant first, as operation's executor does. */
  guard?: StepGuard;
  /** The container set this worker's tenants live in (decision 0013 §3). Default `rehearsal`. */
  containerSet?: string;
  /** How long to wait for the set's lock before failing as busy. Default 10 minutes. */
  setWaitMs?: number;
}

/** The transport modes a scenario names for one step, applied inside the rehearsal's own ports. */
interface Transport {
  failKeys: Map<string, string>;
  drop: { key: string; actionId: string } | null;
  dropped: boolean;
  /** While set, a read of the dropped step answers indeterminate: the worker "died" with it. */
  blockDroppedReads: boolean;
  fired: Set<string>;
}

function challengedProviders(
  providers: Partial<Record<Vendor, ProviderPort>>,
  t: Transport,
): Partial<Record<Vendor, ProviderPort>> {
  const keyIn = (request: unknown, keys: Iterable<string>) => {
    const text = JSON.stringify(request);
    for (const key of keys) if (text.includes(key)) return key;
    return null;
  };
  const wrapped: Partial<Record<Vendor, ProviderPort>> = {};
  for (const [vendor, inner] of Object.entries(providers) as [Vendor, ProviderPort][]) {
    if (!inner) continue;
    wrapped[vendor] = {
      ...inner,
      dispatch: async (request, world) => {
        const failed = keyIn(request, t.failKeys.keys());
        if (failed) {
          // Answered here, never sent: a definite, non-retryable rejection of that one step.
          t.fired.add(t.failKeys.get(failed) as string);
          return {
            kind: "rejected",
            status: 422,
            body: { error: "rehearsal challenge: this step fails" },
            retryable: false,
          };
        }
        if (t.drop && !t.dropped && keyIn(request, [t.drop.key])) {
          const result = await inner.dispatch(request, world);
          if (result.kind !== "confirmed") return result;
          // Committed, and the answer is lost once: the outcome is unknown to this pass.
          t.dropped = true;
          t.fired.add(t.drop.actionId);
          return { kind: "unknown", error: "response dropped after commit (rehearsal challenge)" };
        }
        return inner.dispatch(request, world);
      },
      reconcile: async (attempt, action, world) => {
        if (t.drop && t.blockDroppedReads && attempt.operationKey === t.drop.key) {
          return {
            kind: "indeterminate",
            detail: "the response was dropped; the restart reads it back",
          };
        }
        return inner.reconcile(attempt, action, world);
      },
      // The dropped step is recovered by reading, never by a blind re-send.
      idempotentResend: (action) =>
        t.drop?.actionId === action.id ? false : (inner.idempotentResend?.(action) ?? false),
    };
  }
  return wrapped;
}

export type RehearsalRunResult =
  | { kind: "skipped"; reason: string }
  | {
      kind: "ran";
      state: "completed" | "failed" | "cancelled";
      report: ExecutionRehearsalReport | null;
    };

/** A step's outcome as a rehearsal records it. Compensation outcomes become their forward write. */
function stepOutcome(r: Receipt): { outcome: RehearsalStepOutcome; extra: string[] } {
  if (r.outcome === "compensated" || r.outcome === "compensation_conflict") {
    return { outcome: "confirmed", extra: [`then ${r.outcome.replace("_", " ")} by compensation`] };
  }
  return { outcome: r.outcome, extra: [] };
}

/**
 * Run one `rehearsal` job. It claims the rehearsal (`queued → provisioning`; a redelivery finds it
 * claimed and skips), checks the stored plan and its baseline snapshot against the rehearsal's
 * bindings, has the operator provision the tenants, executes the exact stored plan with no model,
 * records one result per step and the report, and tears down. It never revises the plan, never
 * touches its evidence or grants, and nothing it writes can be adopted by operational apply.
 */
export async function runRehearsalJob(
  data: unknown,
  ctx: RehearsalRunContext,
): Promise<RehearsalRunResult> {
  const parsed = ExecutionRehearsalJob.safeParse(data);
  if (!parsed.success) return { kind: "skipped", reason: "malformed rehearsal job" };
  const job = parsed.data;
  const { orgId } = job.plan;
  const id = job.rehearsalId;
  const stored = await loadRehearsal(ctx.db, orgId, id);
  const r = stored?.rehearsal;
  if (
    !stored ||
    !r ||
    r.planId !== job.plan.planId ||
    r.revision !== job.plan.revision ||
    r.planHash !== job.plan.planHash ||
    r.scenarioId !== job.scenario.id ||
    r.scenarioVersion !== job.scenario.version ||
    r.snapshotDigest !== job.snapshot.digest ||
    r.policyId !== job.policy.id ||
    r.policyVersion !== job.policy.version
  ) {
    return { kind: "skipped", reason: "job does not match a stored rehearsal" };
  }
  const listed = lookupScenario(job.scenario);
  const now = () => ctx.clock.now();
  if (!(await transitionRehearsal(ctx.db, orgId, id, ["queued"], "provisioning", { now: now() }))) {
    return { kind: "skipped", reason: `rehearsal is ${stored.state}` };
  }
  const startedAt = now().toISOString();
  let notFromEvidence: string[] = [];

  const finish = async (
    state: "completed" | "failed" | "cancelled",
    detail: string | null,
    manifest: PlanManifest | null,
    outcome: RunOutcome | null,
  ): Promise<RehearsalRunResult> => {
    const current = (await loadRehearsal(ctx.db, orgId, id))?.state;
    if (current !== state) {
      await transitionRehearsal(
        ctx.db,
        orgId,
        id,
        ["provisioning", "running", "verifying"],
        state,
        { now: now(), detail },
      );
    }
    const ended = (await loadRehearsal(ctx.db, orgId, id))?.state;
    let report: ExecutionRehearsalReport | null = null;
    const inFlight = await rehearsalInFlight(ctx.db, orgId, id);
    if (manifest && (ended === "completed" || ended === "failed" || ended === "cancelled")) {
      // Read the tenant before teardown resets it. The sweeper's later report, if this one is
      // already stored, does not get another chance at these reads.
      let verifications: ReadonlyMap<string, RehearsalVerification> | undefined;
      let versions = ctx.versions;
      if (ctx.verify) {
        const latest = new Map(
          (outcome?.receipts ?? []).map((receipt) => [receipt.actionId, receipt]),
        );
        const results = manifest.actions.flatMap((action) => {
          const receipt = latest.get(action.id);
          if (!receipt) return [];
          return [{ actionId: action.id, outcome: stepOutcome(receipt).outcome }];
        });
        try {
          verifications = await ctx.verify({ manifest, job, results });
        } catch (err) {
          verifications = new Map(
            manifest.actions.map((action) => [
              action.id,
              {
                status: "unverified" as const,
                detail: `the independent read failed: ${(err as Error).message}`,
              },
            ]),
          );
        }
        versions = { ...ctx.versions, verifier: VERIFIER_VERSION };
      }
      report = rehearsalReport(job, manifest, outcome?.receipts ?? [], {
        state: ended,
        limitations: [
          ...(detail ? [detail] : []),
          ...(inFlight.length > 0 ? [IN_FLIGHT_KEPT] : []),
        ],
        notFromEvidence,
        startedAt,
        finishedAt: now().toISOString(),
        versions,
        evidence: ctx.evidence,
        verifications,
      });
      // The sweeper may have ended it and reported first (an expired lease); the first one stands.
      await saveRehearsalReport(ctx.db, orgId, report, now()).catch(() => {
        report = null;
      });
    }
    // A send whose outcome is unknown keeps the tenant for reads: the sweeper reconciles it and
    // tears down only once nothing is in flight (or hands it to an operator).
    if (inFlight.length > 0) {
      await releaseSet();
      return {
        kind: "ran",
        state: (ended as "completed" | "failed" | "cancelled") ?? state,
        report,
      };
    }
    await ctx
      .teardown(id, (ended as "completed" | "failed" | "cancelled") ?? state)
      .then(() => markRehearsalTornDown(ctx.db, orgId, id, now()))
      .catch(() => {}); // a failed teardown leaves the tenant for T3.16's sweeper
    await releaseSet();
    return { kind: "ran", state: (ended as "completed" | "failed" | "cancelled") ?? state, report };
  };
  let setLock: { release: () => Promise<void> } | null = null;
  let marked = false;
  /**
   * Confirmed cleanup, then the set is free. Catalog v1 sets no container-wide fault (a
   * container-wide scenario is refused before anything is injected), so there is nothing beyond
   * the tenant to undo, and the mark is cleared as soon as the run has stopped sending.
   */
  const releaseSet = async () => {
    if (marked) {
      await clearContainerSetDirty(
        ctx.db,
        id,
        "runner: no container-wide fault (catalog v1)",
        now(),
      );
      marked = false;
    }
    await setLock?.release();
    setLock = null;
  };

  // The exact stored plan, as bound: never actions from a caller, never a silent revision.
  const [plan] = await ctx.db
    .select()
    .from(planVersions)
    .where(
      and(
        eq(planVersions.orgId, orgId),
        eq(planVersions.planId, r.planId),
        eq(planVersions.revision, r.revision),
      ),
    );
  const manifest = PlanManifest.safeParse(plan?.manifest);
  if (
    !plan ||
    !manifest.success ||
    plan.planHash !== r.planHash ||
    computePlanHash(manifest.data) !== r.planHash
  ) {
    return finish("failed", "the stored plan no longer matches the rehearsal's hash", null, null);
  }
  if (snapshotDigest(manifest.data) !== r.snapshotDigest) {
    return finish("failed", "the plan's evidence no longer matches the bound snapshot", null, null);
  }
  if (!listed) {
    return finish(
      "failed",
      `scenario ${r.scenarioId}@${r.scenarioVersion} is not on the challenge allowlist`,
      null,
      null,
    );
  }
  // Bind the scenario to this plan: roles become this plan's records, or the run is refused whole.
  const resolved = resolveScenario(manifest.data, job.scenario);
  if (!resolved.ok) {
    return finish("failed", `scenario does not bind to this plan: ${resolved.reason}`, null, null);
  }
  const scenario = resolved.scenario;
  if (scenario.containerWide) {
    return finish("failed", "a container-wide challenge has no confirmed cleanup yet", null, null);
  }
  const ops = challengeOperations(scenario);
  const challenged = scenario.challenges.length > 0;
  const operatorOps = ops.filter((o) => o.kind === "inject_records" || o.kind === "vendor_write");
  if (operatorOps.length > 0 && !ctx.challenge) {
    return finish(
      "failed",
      `scenario ${scenario.id}@${scenario.version} needs the operator's challenge route, which this worker doesn't have`,
      null,
      null,
    );
  }
  // One challenge per container set at a time; unchallenged runs share it (decision 0013 §3).
  const set = ctx.containerSet ?? DEFAULT_CONTAINER_SET;
  setLock = await holdContainerSet(ctx.db, set, challenged ? "exclusive" : "shared", {
    waitMs: ctx.setWaitMs ?? 10 * 60_000,
  });
  if (!setLock) {
    return finish("failed", `container set ${set} stayed busy`, null, null);
  }
  const dirty = await dirtyMarkOn(ctx.db, set, id);
  if (dirty) {
    return finish(
      "failed",
      `container set ${set} is marked dirty by rehearsal ${dirty.rehearsalId}: its cleanup isn't confirmed`,
      null,
      null,
    );
  }

  const provisioned = await ctx.provision(manifest.data, id);
  if (!provisioned.ok) {
    return finish("failed", `snapshot refused: ${provisioned.refusals.join("; ")}`, null, null);
  }
  notFromEvidence = provisioned.notFromEvidence;
  if (challenged) {
    await markContainerSetDirty(ctx.db, { set, orgId, rehearsalId: id, now: now() });
    marked = true;
  }
  if (ops.some((o) => o.kind === "inject_records")) {
    try {
      await ctx.challenge?.({ rehearsalId: id, phase: "before_run" });
    } catch (err) {
      return finish("failed", `challenge inject failed: ${(err as Error).message}`, null, null);
    }
  }
  if (
    !(await transitionRehearsal(ctx.db, orgId, id, ["provisioning"], "running", { now: now() }))
  ) {
    return finish("cancelled", null, manifest.data, null);
  }

  const journal = new RehearsalRunJournal(ctx.db, orgId, id);
  const keyOf = (actionId: string) => {
    const action = manifest.data.actions.find((a) => a.id === actionId);
    return action ? rehearsalOperationKey(id, operationKey(orgId, r.planId, action)) : null;
  };
  const transport: Transport = {
    failKeys: new Map(),
    drop: null,
    dropped: false,
    blockDroppedReads: true,
    fired: new Set(),
  };
  for (const op of ops) {
    if (op.kind !== "runner_transport") continue;
    const key = keyOf(op.actionId);
    if (!key) return finish("failed", `challenge names no step ${op.actionId}`, null, null);
    if (op.mode === "fail_step") transport.failKeys.set(key, op.actionId);
    else transport.drop = { key, actionId: op.actionId };
  }
  const providers = challenged ? challengedProviders(ctx.providers, transport) : ctx.providers;
  const base =
    ctx.compensate ??
    (providers.zendesk
      ? createCompensator({ providers, worlds: ctx.worlds, clock: ctx.clock })
      : undefined);
  const edit = ops.find(
    (o): o is Extract<ChallengeOperation, { kind: "vendor_write" }> => o.kind === "vendor_write",
  );
  let editApplied = false;
  // The teammate edit lands after its step is rejected and before compensation re-reads the ticket.
  const compensate: Compensator | undefined = edit
    ? async (cctx) => {
        if (!editApplied && cctx.outcomes.get(edit.when.afterActionId) === "rejected") {
          await ctx.challenge?.({
            rehearsalId: id,
            phase: "after_rejected",
            actionId: edit.when.afterActionId,
          });
          editApplied = true;
        }
        await base?.(cctx);
      }
    : base;
  const pass = () =>
    executeRehearsal(
      { orgId, rehearsalId: id, planId: r.planId, revision: r.revision, planHash: r.planHash },
      {
        plans: {
          loadPlan: async () => ({ planHash: plan.planHash, manifest: plan.manifest }),
          // Cancelled, or ended by the sweeper (an expired lease): either way no fresh send.
          rehearsalCancelled: async () =>
            (await loadRehearsal(ctx.db, orgId, id))?.state !== "running",
        },
        journal,
        providers,
        worlds: ctx.worlds,
        clock: ctx.clock,
        policies: ctx.policies,
        newId: ctx.newId,
        guard: ctx.guard,
        compensate,
        retry: ctx.retry,
        sleep: ctx.sleep,
      },
    );
  let outcome: RunOutcome;
  try {
    outcome = await pass();
    if (transport.drop && transport.dropped && !outcome.refusal) {
      // The controlled restart: the same journal, reads allowed again. The dropped step is
      // reconciled by reading the one effect, and the steps it held go on. Nothing is re-sent.
      transport.blockDroppedReads = false;
      const restart = await pass();
      outcome = { ...restart, receipts: [...journal.receipts] };
    }
  } catch (err) {
    return finish("failed", `rehearsal stopped: ${(err as Error).message}`, manifest.data, null);
  }
  const missed = [
    ...[...transport.failKeys.values()].filter((a) => !transport.fired.has(a)),
    ...(transport.drop && !transport.dropped ? [transport.drop.actionId] : []),
    ...(edit && !editApplied ? [`teammate edit after ${edit.when.afterActionId}`] : []),
  ];
  if (outcome.refusal) return finish("failed", outcome.refusal, manifest.data, outcome);
  if (missed.length > 0 && outcome.state !== "cancelled") {
    return finish(
      "failed",
      `the scenario's challenge never applied: ${missed.join(", ")}`,
      manifest.data,
      outcome,
    );
  }

  // Ended under it (cancelled, or failed by the sweeper): the report carries what happened.
  const after = (await loadRehearsal(ctx.db, orgId, id))?.state;
  if (after !== "running") {
    return finish(after === "failed" ? "failed" : "cancelled", null, manifest.data, outcome);
  }
  // One result per step: its latest receipt in this pass.
  const latest = new Map(outcome.receipts.map((x) => [x.actionId, x]));
  for (const action of manifest.data.actions) {
    const receipt = latest.get(action.id);
    if (!receipt) continue;
    await recordRehearsalStepResult(
      ctx.db,
      orgId,
      toStepResult(job, action, receipt),
      ctx.newId("rsr"),
    );
  }
  if (outcome.state === "cancelled") return finish("cancelled", null, manifest.data, outcome);
  if (outcome.error) return finish("failed", outcome.error, manifest.data, outcome);
  await transitionRehearsal(ctx.db, orgId, id, ["running"], "verifying", { now: now() });
  return finish("completed", null, manifest.data, outcome);
}

/** A receipt from the rehearsal's journal as its step result, under the real plan hash. */
function toStepResult(
  job: Pick<ExecutionRehearsalJob, "rehearsalId" | "plan">,
  action: PlanManifest["actions"][number],
  receipt: Receipt,
): RehearsalStepResult {
  const { outcome, extra } = stepOutcome(receipt);
  return {
    world: "rehearsal",
    rehearsalId: job.rehearsalId,
    actionId: action.id,
    planHash: job.plan.planHash,
    operationKey: rehearsalOperationKey(
      job.rehearsalId,
      operationKey(job.plan.orgId, job.plan.planId, action),
    ),
    outcome,
    providerRef: receipt.providerRef,
    observedEffect: receipt.observedEffect,
    holdReason: receipt.holdReason,
    limitations: [...receipt.limitations, ...extra],
    recordedAt: receipt.recordedAt,
  };
}
