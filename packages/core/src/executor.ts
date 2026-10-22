import {
  type Action,
  type ApprovalGrant,
  type EntityRef,
  type HoldReason,
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
}

/** Per-step guard hook (T4). Returning a reason holds the step; the model never sits here. */
export type StepGuard = (action: Action, manifest: PlanManifest) => Promise<HoldReason | null>;

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
 * Stable per org + target + action kind + obligation, NOT per plan revision: if a changed plan is
 * re-approved, the same refund keeps the same idempotency key and can't be issued twice.
 */
export function operationKey(orgId: string, action: Action): string {
  const t = targetOf(action);
  return `op_${fingerprint({ orgId, kind: action.kind, obligationId: action.obligationId, target: t }).slice(0, 32)}`;
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
  if (Date.parse(grant.expiresAt) <= now) return { ok: false, detail: "grant expired" };
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
  const { journal, clock } = deps;
  const at = () => clock.now().toISOString();
  const admission = await admit(job, deps);

  if (!admission.ok) {
    await journal.appendEvent(job.runId, "run.refused", { detail: admission.detail });
    return { state: "failed", receipts: [], refusal: admission.detail };
  }
  const { manifest, grant } = admission;
  await journal.appendEvent(job.runId, "run.admitted", {
    planHash: job.planHash,
    approvalId: grant.id,
  });

  const receipts: Receipt[] = [];
  const settled = new Map<string, ReceiptOutcome>();
  const bindings = new Map<string, string | number>(
    (await journal.bindings(job.planHash)).map((b) => [bindingKey(b.ref), b.value]),
  );

  const record = async (
    action: Action,
    outcome: ReceiptOutcome,
    extra: Partial<
      Pick<Receipt, "providerRef" | "observedEffect" | "holdReason" | "limitations">
    > = {},
  ) => {
    const receipt: Receipt = {
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
    };
    await journal.recordReceipt(receipt);
    await journal.appendEvent(job.runId, "step.receipt", receipt);
    receipts.push(receipt);
    settled.set(action.id, outcome);
  };

  for (const action of topoOrder(manifest.actions)) {
    const blocked = action.dependsOn.find((d) => settled.get(d) !== "confirmed");
    if (blocked) {
      await record(action, "skipped_dependency", {
        holdReason: { kind: "predecessor_not_confirmed", stepId: blocked },
      });
      continue;
    }

    const key = operationKey(job.orgId, action);
    const prior = await journal.attemptsFor(job.planHash, action.id);
    if (prior.some((a) => a.state === "confirmed" || a.state === "reconciled")) {
      // Already applied in an earlier run of this job; its receipt and bindings exist.
      settled.set(action.id, "confirmed");
      continue;
    }
    const inFlight = prior.find((a) => a.state === "dispatched" || a.state === "unknown_outcome");
    if (inFlight) {
      // TODO(T3.5): reconcile through reads. Until then never re-send; hold for an operator.
      await record(action, "held", {
        holdReason: { kind: "unresolved_outcome", attemptId: inFlight.id },
      });
      continue;
    }

    const hold = deps.guard ? await deps.guard(action, manifest) : null;
    if (hold) {
      await record(action, "held", { holdReason: hold });
      continue;
    }

    const refs = resultRefsOf(action);
    const unresolved = refs.find((r) => !bindings.has(bindingKey(r)));
    if (unresolved) {
      await record(action, "held", {
        holdReason: { kind: "predecessor_not_confirmed", stepId: unresolved.stepId },
      });
      continue;
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
    const reusable = prior.find((a) => a.state === "prepared");
    if (reusable && reusable.request.bodySha256 !== bodySha256) {
      await record(action, "held", {
        holdReason: {
          kind: "approval_invalid",
          detail: "re-prepared request differs from the journaled bytes",
        },
      });
      continue;
    }

    const attemptId = reusable?.id ?? deps.newId("att");
    if (!reusable) {
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

    let result: DispatchResult;
    try {
      result = await provider.dispatch(request, world);
    } catch (err) {
      result = { kind: "unknown", error: (err as Error).message };
    }

    if (result.kind === "confirmed") {
      const { providerRef, results } = resultsOf(action, result.body);
      await journal.transition(attemptId, "dispatched", "confirmed", {
        providerStatus: result.status,
        settledAt: at(),
      });
      for (const [path, value] of Object.entries(results)) {
        await journal.bind({
          planHash: job.planHash,
          ref: { $ref: "result", stepId: action.id, path: path as ResultRef["path"] },
          value,
        });
        bindings.set(bindingKey({ stepId: action.id, path: path as ResultRef["path"] }), value);
      }
      await record(action, "confirmed", {
        providerRef,
        observedEffect: results,
        limitations: ["effect taken from the write response; no read-back yet"],
      });
    } else if (result.kind === "rejected") {
      // TODO(T3.4): bounded retries with the identical request when `retryable`.
      await journal.transition(attemptId, "dispatched", "rejected", {
        providerStatus: result.status,
        error: JSON.stringify(result.body).slice(0, 500),
        settledAt: at(),
      });
      await record(action, "rejected", { observedEffect: { status: result.status } });
    } else {
      await journal.transition(attemptId, "dispatched", "unknown_outcome", { error: result.error });
      await record(action, "unknown_outcome", {
        holdReason: { kind: "unresolved_outcome", attemptId },
      });
    }
  }

  const outcomes = manifest.actions.map((a) => settled.get(a.id));
  const confirmed = outcomes.filter((o) => o === "confirmed").length;
  const state: RunState =
    confirmed === outcomes.length
      ? "completed"
      : confirmed > 0
        ? "partial"
        : outcomes.some((o) => o === "held" || o === "unknown_outcome")
          ? "held"
          : "failed";
  await journal.appendEvent(job.runId, "run.finished", { state });
  return { state, receipts, refusal: null };
}
