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
  type RehearsalVersions,
  type RunEvent,
  type Vendor,
} from "@rehearsal/contracts";
import {
  type BillingPolicy,
  type Clock,
  type Compensator,
  planHash as computePlanHash,
  executeRehearsal,
  fingerprint,
  type JournalPort,
  operationKey,
  type ProviderPort,
  type RetryPolicy,
  type RunOutcome,
  rehearsalOperationKey,
  type SettleStep,
  snapshotDigest,
  type WorldContext,
} from "@rehearsal/core";
import { and, eq } from "drizzle-orm";
import type { Db } from "./index";
import { isLegalTransition } from "./journal";
import {
  loadRehearsal,
  markRehearsalTornDown,
  recordRehearsalStepResult,
  saveRehearsalReport,
  transitionRehearsal,
} from "./rehearsals";
import { planVersions, rehearsalAttempts } from "./schema";

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
  compensate?: Compensator;
  retry?: Partial<RetryPolicy>;
  sleep?: (ms: number) => Promise<void>;
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
    if (manifest && (ended === "completed" || ended === "failed" || ended === "cancelled")) {
      const latest = new Map((outcome?.receipts ?? []).map((x) => [x.actionId, x]));
      report = {
        world: "rehearsal",
        rehearsalId: id,
        plan: job.plan,
        scenario: job.scenario,
        challengesDigest: fingerprint([]),
        snapshot: job.snapshot,
        policy: job.policy,
        versions: ctx.versions,
        evidence: ctx.evidence,
        state: ended,
        verdict: "unknown",
        steps: manifest.actions.map((action) => {
          const receipt = latest.get(action.id);
          return {
            actionId: action.id,
            expected: "confirmed",
            result: receipt ? toStepResult(job, action, receipt) : null,
            verification: {
              status: "unverified",
              detail: "the independent verifier (T4.12) has not read this step",
            },
          };
        }),
        notFromEvidence,
        limitations: [
          "no independent verification yet (T4.12): the verdict stays unknown",
          ...(detail ? [detail] : []),
        ],
        startedAt,
        finishedAt: now().toISOString(),
      };
      await saveRehearsalReport(ctx.db, orgId, report, now());
    }
    await ctx
      .teardown(id, (ended as "completed" | "failed" | "cancelled") ?? state)
      .then(() => markRehearsalTornDown(ctx.db, orgId, id, now()))
      .catch(() => {}); // a failed teardown leaves the tenant for T3.16's sweeper
    return { kind: "ran", state: (ended as "completed" | "failed" | "cancelled") ?? state, report };
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
  if (r.scenarioId !== "clean") {
    return finish("failed", `scenario ${r.scenarioId} isn't supported until T4.11`, null, null);
  }

  const provisioned = await ctx.provision(manifest.data, id);
  if (!provisioned.ok) {
    return finish("failed", `snapshot refused: ${provisioned.refusals.join("; ")}`, null, null);
  }
  notFromEvidence = provisioned.notFromEvidence;
  if (
    !(await transitionRehearsal(ctx.db, orgId, id, ["provisioning"], "running", { now: now() }))
  ) {
    return finish("cancelled", null, manifest.data, null);
  }

  const journal = new RehearsalRunJournal(ctx.db, orgId, id);
  let outcome: RunOutcome;
  try {
    outcome = await executeRehearsal(
      { orgId, rehearsalId: id, planId: r.planId, revision: r.revision, planHash: r.planHash },
      {
        plans: {
          loadPlan: async () => ({ planHash: plan.planHash, manifest: plan.manifest }),
          rehearsalCancelled: async () =>
            (await loadRehearsal(ctx.db, orgId, id))?.state === "cancelled",
        },
        journal,
        providers: ctx.providers,
        worlds: ctx.worlds,
        clock: ctx.clock,
        policies: ctx.policies,
        newId: ctx.newId,
        compensate: ctx.compensate,
        retry: ctx.retry,
        sleep: ctx.sleep,
      },
    );
  } catch (err) {
    return finish("failed", `rehearsal stopped: ${(err as Error).message}`, manifest.data, null);
  }
  if (outcome.refusal) return finish("failed", outcome.refusal, manifest.data, outcome);

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
  job: ExecutionRehearsalJob,
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
