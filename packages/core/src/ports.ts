import type {
  Action,
  Attempt,
  AttemptState,
  EntityRef,
  ImpactRequest,
  ImpactResponse,
  ObjectBinding,
  Observation,
  PlanManifest,
  QueryObservation,
  QueryPredicate,
  Receipt,
  RunEvent,
  Vendor,
  World,
} from "@rehearsal/contracts";

/**
 * The five frozen ports. Implementations live in other packages (providers, db, planner,
 * memory, impact-service); fakes live in @rehearsal/testkit.
 */

export interface Clock {
  now(): Date;
}

export interface WorldContext {
  world: World;
  tenant: string;
}

/** Exact bytes to send. Persisted in the journal before dispatch and reused verbatim on retry. */
export interface PreparedRequest {
  method: Attempt["request"]["method"];
  path: string;
  encoding: Attempt["request"]["encoding"];
  body: string;
  headers: Record<string, string>;
}

export type DispatchResult =
  | { kind: "confirmed"; status: number; body: unknown }
  | { kind: "rejected"; status: number; body: unknown; retryable: boolean; retryAfterMs?: number }
  /** Transport failed after the request may have reached the provider. Never blindly retry. */
  | { kind: "unknown"; error: string };

export type ReconcileResult =
  | { kind: "applied"; providerRef: EntityRef; effect: Record<string, unknown> }
  | { kind: "not_applied" }
  | { kind: "indeterminate"; detail: string };

/** Resolved values for an action's ResultRefs, from confirmed predecessor receipts. */
export type ResolvedBindings = ReadonlyMap<string, string | number>;

export interface ProviderPort {
  readonly vendor: Vendor;
  observe(entity: EntityRef, ctx: WorldContext): Promise<Observation>;
  /** Must enumerate every page; set `complete: false` if it could not. */
  query(predicate: QueryPredicate, cutoff: string, ctx: WorldContext): Promise<QueryObservation>;
  prepare(action: Action, bindings: ResolvedBindings, operationKey: string): PreparedRequest;
  dispatch(request: PreparedRequest, ctx: WorldContext): Promise<DispatchResult>;
  /** Resolve an unknown outcome through authoritative reads, never by re-sending. */
  reconcile(attempt: Attempt, action: Action, ctx: WorldContext): Promise<ReconcileResult>;
}

export interface SettleStep {
  transition?: {
    attemptId: string;
    from: AttemptState;
    to: AttemptState;
    patch?: Partial<Pick<Attempt, "providerStatus" | "error" | "dispatchedAt" | "settledAt">>;
  };
  bindings: ObjectBinding[];
  receipt: Receipt;
}

export interface JournalPort {
  /** Persist intent + exact request BEFORE dispatch. */
  prepareAttempt(attempt: Attempt): Promise<void>;
  /** Compare-and-set transition; throws if the attempt is not in `from`. */
  transition(
    attemptId: string,
    from: AttemptState,
    to: AttemptState,
    patch?: Partial<Pick<Attempt, "providerStatus" | "error" | "dispatchedAt" | "settledAt">>,
  ): Promise<Attempt>;
  attemptsFor(planHash: string, actionId: string): Promise<Attempt[]>;
  /** Every attempt with this operation key (any plan revision), ordered by attemptNo. */
  attemptsForKey(operationKey: string): Promise<Attempt[]>;
  /**
   * Atomically settle a step: an optional compare-and-set transition, its write-once result
   * bindings and its receipt. All or nothing, so a crash can't leave a confirmed attempt without
   * the receipt and bindings later steps depend on.
   */
  settle(step: SettleStep): Promise<void>;
  recordReceipt(receipt: Receipt): Promise<void>;
  /** Receipts recorded for one plan hash, oldest first. */
  receiptsFor(planHash: string): Promise<Receipt[]>;
  bind(binding: ObjectBinding): Promise<void>;
  bindings(planHash: string): Promise<ObjectBinding[]>;
  appendEvent(runId: string, type: string, payload: unknown): Promise<RunEvent>;
}

export interface PlannerInput {
  orgId: string;
  incidentId: string;
  planId: string;
}

export interface PlannerPort {
  plan(input: PlannerInput): Promise<PlanManifest>;
}

export interface Precedent {
  id: string;
  version: number;
  statement: string;
  author: { userId: string; role: string };
}

export interface PrecedentPort {
  recall(caseKey: string): Promise<{ precedents: Precedent[]; traceId: string | null }>;
}

export interface ImpactPort {
  classify(request: ImpactRequest): Promise<ImpactResponse>;
}

/** Core mode: no memory service. */
export const noPrecedents: PrecedentPort = {
  recall: async () => ({ precedents: [], traceId: null }),
};

/** Core mode: the impact model always abstains, so execution never depends on it. */
export const alwaysAbstain: ImpactPort = {
  classify: async () => ({
    label: "abstain",
    score: null,
    modelRevision: "always-abstain",
    evidenceRefs: [],
  }),
};
