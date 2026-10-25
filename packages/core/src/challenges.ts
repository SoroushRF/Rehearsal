import type {
  Action,
  HoldReason,
  PlanManifest,
  QueryObservation,
  RehearsalScenarioId,
  RehearsalStepOutcome,
} from "@rehearsal/contracts";
import { fingerprint } from "./hash";
import { rehearsalTenant } from "./rehearsal";

/**
 * T4.11: the allowlisted execution-rehearsal challenges (decision 0013). A caller names
 * `scenarioId@version` and nothing else. This module is the list: what each version does, which
 * step outcomes and world effects it expects, and how those roles bind to one plan's evidence.
 *
 * Records are roles in the plan (a case's refund, the window query it cites), resolved when the
 * run is bound. The catalog has no customer ids, no charge ids and no fault JSON. A
 * changed-precedent challenge is not here; it waits on the precedent registry, and its absence is
 * not a stub of that guard.
 *
 * v1 sets no container-wide Era fault. Injects go to one rehearsal tenant. A lost response is a
 * named transport mode the runner applies to one step. Evidence is `fixture` until a run on Era.
 */

/** The version a caller asks for. Older versions stay in the list so a stored report still resolves. */
export const CHALLENGE_CATALOG_VERSION = 1;

const DAY_SEC = 86_400;

type Evidence = Pick<PlanManifest, "actions" | "observations" | "queryObservations">;

type StepKind =
  | "stripe.refund.create"
  | "zendesk.ticket.patchFields"
  | "zendesk.ticket.appendPrivateNote";

/** A step named by its place in the plan, never by an id from a fixture or a cohort. */
export interface StepSelector {
  caseOrdinal: number;
  kind: StepKind;
}

export type ChallengeSpec =
  | {
      kind: "phantom_charge";
      refund: StepSelector;
      /** Seconds after the cited window opens. The instant must fall strictly inside it. */
      createdOffsetSec: number;
    }
  | {
      kind: "outside_window_charge";
      refund: StepSelector;
      /** Seconds after the cited window ends. The instant must fall strictly outside it. */
      createdOffsetFromEndSec: number;
    }
  | { kind: "fail_step"; step: StepSelector }
  | {
      kind: "teammate_field_edit";
      patch: StepSelector;
      field: "priority";
      /** A priority the plan neither observed nor writes, so the edit stays visible. */
      value: "urgent";
      /**
       * Applied once this step has been rejected and before compensation re-reads the ticket.
       * Earlier, the note's own re-read holds. Later, compensation restores the plan's value
       * and the conflict receipt is lost.
       */
      afterFailedStep: StepSelector;
    }
  | {
      kind: "drop_response_after_commit";
      step: StepSelector;
      /** The runner restarts after the drop and recovers the one effect by reading. */
      thenRestart: true;
    };

type HeldExpectation = {
  caseOrdinal: number;
  kind: StepKind;
  outcome: "held";
  holdKind: "query_membership_changed";
};

type OtherExpectation = {
  caseOrdinal: number;
  kind: StepKind;
  outcome: Exclude<RehearsalStepOutcome, "held">;
};

export type StepExpectation = HeldExpectation | OtherExpectation;

export type EffectSpec =
  | {
      kind: "query_membership";
      refund: StepSelector;
      role: "phantom" | "control";
      member: boolean;
    }
  | { kind: "refund_count"; refund: StepSelector; count: 0 | 1 }
  | {
      kind: "ticket_field";
      patch: StepSelector;
      field: "priority";
      /**
       * A role, not a Zendesk priority. The bound effect's `value` is the priority the edit
       * writes (`urgent`). Readers of this JSON must not look for a priority named "teammate".
       */
      equals: "teammate";
    }
  | { kind: "other_refunds_once" };

export interface ScenarioDefinition {
  id: RehearsalScenarioId;
  version: number;
  title: string;
  /**
   * True only when a challenge changes container-wide fault settings. Those hit every tenant in
   * the container, so the runner must hold the set exclusively and confirm cleanup (decision
   * 0013). v1 is false: nothing here sets a fault.
   */
  containerWide: boolean;
  challenges: ChallengeSpec[];
  expected: {
    /** Exceptions. Every other step is `otherSteps`. */
    steps: StepExpectation[];
    otherSteps: "confirmed";
    effects: EffectSpec[];
  };
}

const refund0: StepSelector = { caseOrdinal: 0, kind: "stripe.refund.create" };
const patch0: StepSelector = { caseOrdinal: 0, kind: "zendesk.ticket.patchFields" };
const note0: StepSelector = { caseOrdinal: 0, kind: "zendesk.ticket.appendPrivateNote" };

/**
 * Version 1. `clean` is the control with no challenge. The phantom scenario carries its own
 * non-matching charge, and `benign_nonmatching_change` is that control on its own.
 */
export const CHALLENGE_CATALOG: readonly ScenarioDefinition[] = [
  {
    id: "clean",
    version: 1,
    title: "Nothing changes. Every step confirms.",
    containerWide: false,
    challenges: [],
    expected: { steps: [], otherSteps: "confirmed", effects: [{ kind: "other_refunds_once" }] },
  },
  {
    id: "phantom_membership",
    version: 1,
    title: "An in-window charge joins the cited query. A charge outside it must not.",
    containerWide: false,
    challenges: [
      { kind: "phantom_charge", refund: refund0, createdOffsetSec: 24 * DAY_SEC },
      { kind: "outside_window_charge", refund: refund0, createdOffsetFromEndSec: 9 * DAY_SEC },
    ],
    expected: {
      steps: [
        {
          ...refund0,
          outcome: "held",
          holdKind: "query_membership_changed",
        },
        { ...note0, outcome: "skipped_dependency" },
      ],
      otherSteps: "confirmed",
      effects: [
        { kind: "query_membership", refund: refund0, role: "phantom", member: true },
        { kind: "query_membership", refund: refund0, role: "control", member: false },
        { kind: "refund_count", refund: refund0, count: 0 },
        { kind: "other_refunds_once" },
      ],
    },
  },
  {
    id: "teammate_field_edit",
    version: 1,
    title: "A note fails, then a teammate sets the patched priority. Their value stays.",
    containerWide: false,
    challenges: [
      { kind: "fail_step", step: note0 },
      {
        kind: "teammate_field_edit",
        patch: patch0,
        field: "priority",
        value: "urgent",
        afterFailedStep: note0,
      },
    ],
    expected: {
      steps: [{ ...note0, outcome: "rejected" }],
      otherSteps: "confirmed",
      effects: [
        { kind: "ticket_field", patch: patch0, field: "priority", equals: "teammate" },
        { kind: "other_refunds_once" },
      ],
    },
  },
  {
    id: "lost_response_restart",
    version: 1,
    title: "The refund commits, its response is dropped, and a restart reads the one effect back.",
    containerWide: false,
    challenges: [{ kind: "drop_response_after_commit", step: refund0, thenRestart: true }],
    expected: {
      steps: [],
      otherSteps: "confirmed",
      effects: [
        { kind: "refund_count", refund: refund0, count: 1 },
        { kind: "other_refunds_once" },
      ],
    },
  },
  {
    id: "benign_nonmatching_change",
    version: 1,
    title: "A charge for the same customer falls outside the cited window. Nothing is held.",
    containerWide: false,
    challenges: [
      { kind: "outside_window_charge", refund: refund0, createdOffsetFromEndSec: 9 * DAY_SEC },
    ],
    expected: {
      steps: [],
      otherSteps: "confirmed",
      effects: [
        { kind: "query_membership", refund: refund0, role: "control", member: false },
        { kind: "refund_count", refund: refund0, count: 1 },
        { kind: "other_refunds_once" },
      ],
    },
  },
];

const FORBIDDEN_KEYS = new Set([
  "config",
  "fault",
  "faults",
  "baseUrl",
  "url",
  "tenant",
  "records",
  "method",
  "path",
  "body",
]);

/** Why the catalog itself is not publishable. Empty means it can be resolved. */
export function catalogProblems(catalog: readonly ScenarioDefinition[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const scenario of catalog) {
    const key = `${scenario.id}@${scenario.version}`;
    if (seen.has(key)) problems.push(`${key} is listed twice`);
    seen.add(key);
    if (!Number.isInteger(scenario.version) || scenario.version < 1) {
      problems.push(`${key} has a bad version`);
    }
    if (scenario.version > CHALLENGE_CATALOG_VERSION) {
      problems.push(`${key} is newer than the published version ${CHALLENGE_CATALOG_VERSION}`);
    }
    if (scenario.containerWide) {
      problems.push(`${key} sets a container-wide fault; v1 has no confirmed cleanup for one`);
    }
    problems.push(...shapeProblems(scenario));
    walk(scenario, key, problems);
  }
  for (const id of [
    "clean",
    "phantom_membership",
    "teammate_field_edit",
    "lost_response_restart",
    "benign_nonmatching_change",
  ] as const) {
    if (!catalog.some((s) => s.id === id && s.version === CHALLENGE_CATALOG_VERSION)) {
      problems.push(`${id}@${CHALLENGE_CATALOG_VERSION} is missing`);
    }
  }
  const clean = catalog.find((s) => s.id === "clean" && s.version === CHALLENGE_CATALOG_VERSION);
  if (clean && clean.challenges.length > 0) problems.push("clean has a challenge");
  return problems;
}

/** Structural rules that keep a version from drifting into a fault payload or a silent hold. */
function shapeProblems(scenario: ScenarioDefinition): string[] {
  const problems: string[] = [];
  const key = `${scenario.id}@${scenario.version}`;
  for (const challenge of scenario.challenges) {
    if (challenge.kind === "phantom_charge" && !wholeSeconds(challenge.createdOffsetSec)) {
      problems.push(`${key} phantom offset must be a whole number of seconds`);
    }
    if (
      challenge.kind === "outside_window_charge" &&
      !wholeSeconds(challenge.createdOffsetFromEndSec)
    ) {
      problems.push(`${key} control offset must be a whole number of seconds`);
    }
  }
  if (scenario.id === "phantom_membership") {
    const kinds = scenario.challenges.map((c) => c.kind);
    if (!kinds.includes("phantom_charge") || !kinds.includes("outside_window_charge")) {
      problems.push(`${key} needs an in-window charge and an outside-window control`);
    }
  }
  if (
    scenario.id === "benign_nonmatching_change" &&
    (scenario.expected.steps.length > 0 ||
      scenario.challenges.some((c) => c.kind !== "outside_window_charge"))
  ) {
    problems.push(`${key} may only add a non-matching charge, and it holds nothing`);
  }
  if (scenario.id === "teammate_field_edit") {
    const failed = scenario.challenges.find((c) => c.kind === "fail_step");
    const edit = scenario.challenges.find((c) => c.kind === "teammate_field_edit");
    if (failed?.kind !== "fail_step" || edit?.kind !== "teammate_field_edit") {
      problems.push(`${key} fails a step and then edits the ticket`);
    } else if (
      edit.afterFailedStep.caseOrdinal !== failed.step.caseOrdinal ||
      edit.afterFailedStep.kind !== failed.step.kind
    ) {
      problems.push(`${key} edits the ticket before the failed step`);
    }
  }
  if (scenario.id === "lost_response_restart") {
    const drop = scenario.challenges.find((c) => c.kind === "drop_response_after_commit");
    if (drop?.kind !== "drop_response_after_commit" || !drop.thenRestart) {
      problems.push(`${key} drops one response and restarts`);
    }
  }
  return problems;
}

function wholeSeconds(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function walk(value: unknown, at: string, problems: string[]): void {
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) walk(item, `${at}[${i}]`, problems);
    return;
  }
  if (value === null || typeof value !== "object") {
    if (typeof value === "string" && /^(ch_|cus_)|\/_admin|localhost/.test(value)) {
      problems.push(`${at} carries a record id or a world (${value})`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) problems.push(`${at}.${key} is a caller payload, not a challenge`);
    walk(child, `${at}.${key}`, problems);
  }
}

const catalogErrors = catalogProblems(CHALLENGE_CATALOG);
if (catalogErrors.length > 0) {
  throw new Error(`challenge catalog: ${catalogErrors.join("; ")}`);
}

export function lookupScenario(ref: {
  id: string;
  version: number;
}): ScenarioDefinition | undefined {
  return CHALLENGE_CATALOG.find((s) => s.id === ref.id && s.version === ref.version);
}

/** Digest of the versioned definition, not of the ids it binds to on one plan. */
export function challengesDigest(scenario: ScenarioDefinition): string {
  return fingerprint({
    id: scenario.id,
    version: scenario.version,
    containerWide: scenario.containerWide,
    challenges: scenario.challenges,
    expected: scenario.expected,
  });
}

/** The published list as JSON, evidence `fixture` until a scenario has run on Era. */
export function challengeCatalogDocument(): {
  schemaVersion: 1;
  evidence: "fixture";
  catalogVersion: number;
  /**
   * `equals: "teammate"` in a scenario is a role. Bind the scenario to a plan; the effect's
   * `value` is the priority that is written.
   */
  reading: string;
  scenarios: readonly ScenarioDefinition[];
} {
  return {
    schemaVersion: 1,
    evidence: "fixture",
    catalogVersion: CHALLENGE_CATALOG_VERSION,
    reading:
      'equals "teammate" is a role, not a Zendesk priority. The bound effect value is the priority the edit writes.',
    scenarios: CHALLENGE_CATALOG,
  };
}

export interface ResolvedCharge {
  id: string;
  customerId: string;
  amountMinor: number;
  currency: string;
  created: number;
}

export type ResolvedChallenge =
  | {
      kind: "inject_charge";
      role: "phantom" | "control";
      when: "before_run";
      vendor: "stripe";
      queryId: string;
      charge: ResolvedCharge;
    }
  | {
      kind: "teammate_field_edit";
      /** During that rejection, before compensation reads the ticket. */
      when: { afterActionId: string; outcome: "rejected"; before: "compensation" };
      vendor: "zendesk";
      ticketId: string;
      field: "priority";
      value: "urgent";
    }
  | { kind: "fail_step"; when: "during_run"; actionId: string }
  | {
      kind: "drop_response_after_commit";
      when: "during_run";
      actionId: string;
      thenRestart: true;
    };

export type ResolvedEffect =
  | { kind: "query_membership"; queryId: string; chargeId: string; member: boolean }
  | { kind: "refund_count"; actionId: string; chargeId: string; count: 0 | 1 }
  | { kind: "ticket_field"; actionId: string; ticketId: string; field: "priority"; value: string };

export interface ResolvedStep {
  actionId: string;
  outcome: RehearsalStepOutcome;
  holdKind: Extract<HoldReason, { kind: "query_membership_changed" }>["kind"] | null;
}

export interface ResolvedScenario {
  id: RehearsalScenarioId;
  version: number;
  digest: string;
  containerWide: boolean;
  challenges: ResolvedChallenge[];
  steps: ResolvedStep[];
  effects: ResolvedEffect[];
}

export type ResolveResult =
  | { ok: true; scenario: ResolvedScenario }
  | { ok: false; reason: string };

interface RefundBinding {
  action: Extract<Action, { kind: "stripe.refund.create" }>;
  query: QueryObservation & {
    predicate: { kind: "stripe.charges.byCustomerInWindow" };
  };
  customerId: string;
  amountMinor: number;
  currency: string;
  windowStart: number;
  windowEnd: number;
}

interface ChargeRole {
  role: "phantom" | "control";
  charge: ResolvedCharge;
  queryId: string;
}

/**
 * Bind one published scenario to a plan. A plan that lacks the cited refund, query or ticket is
 * refused whole: nothing is half-resolved, and no id is invented to fill the gap.
 */
export function resolveScenario(
  manifest: Evidence,
  ref: { id: string; version: number },
): ResolveResult {
  const definition = lookupScenario(ref);
  if (!definition) return { ok: false, reason: `${ref.id}@${ref.version} is not on the allowlist` };

  const steps = bindSteps(manifest, definition);
  if (typeof steps === "string") return { ok: false, reason: steps };

  const challenges: ResolvedChallenge[] = [];
  const charges = new Map<"phantom" | "control", ChargeRole>();
  for (const spec of definition.challenges) {
    const bound = bindChallenge(manifest, spec, steps);
    if (typeof bound === "string") return { ok: false, reason: bound };
    challenges.push(bound.challenge);
    if (bound.charge) charges.set(bound.charge.role, bound.charge);
  }

  const effects: ResolvedEffect[] = [];
  const refundCounts = new Set<string>();
  for (const spec of definition.expected.effects) {
    if (spec.kind === "other_refunds_once") continue;
    const bound = bindEffect(manifest, spec, charges);
    if (typeof bound === "string") return { ok: false, reason: bound };
    effects.push(bound);
    if (bound.kind === "refund_count") refundCounts.add(bound.actionId);
  }
  if (definition.expected.effects.some((e) => e.kind === "other_refunds_once")) {
    for (const action of manifest.actions) {
      if (action.kind !== "stripe.refund.create" || refundCounts.has(action.id)) continue;
      effects.push({
        kind: "refund_count",
        actionId: action.id,
        chargeId: action.args.chargeId,
        count: 1,
      });
    }
  }

  for (const step of steps) {
    if (step.outcome !== "skipped_dependency") continue;
    const action = manifest.actions.find((a) => a.id === step.actionId);
    const held = new Set(steps.filter((s) => s.outcome === "held").map((s) => s.actionId));
    if (!action?.dependsOn.some((id) => held.has(id))) {
      return {
        ok: false,
        reason: `${step.actionId} is expected skipped but depends on no held step`,
      };
    }
  }

  return {
    ok: true,
    scenario: {
      id: definition.id,
      version: definition.version,
      digest: challengesDigest(definition),
      containerWide: definition.containerWide,
      challenges,
      steps,
      effects,
    },
  };
}

function bindSteps(manifest: Evidence, definition: ScenarioDefinition): ResolvedStep[] | string {
  const exceptions = new Map<string, StepExpectation>();
  for (const expectation of definition.expected.steps) {
    const action = findAction(manifest.actions, expectation);
    if (typeof action === "string") return action;
    if (exceptions.has(action.id)) return `${action.id} is expected twice`;
    exceptions.set(action.id, expectation);
  }
  return manifest.actions.map((action) => {
    const expectation = exceptions.get(action.id);
    if (!expectation) return { actionId: action.id, outcome: "confirmed" as const, holdKind: null };
    return {
      actionId: action.id,
      outcome: expectation.outcome,
      holdKind: expectation.outcome === "held" ? expectation.holdKind : null,
    };
  });
}

function bindChallenge(
  manifest: Evidence,
  spec: ChallengeSpec,
  steps: readonly ResolvedStep[],
): { challenge: ResolvedChallenge; charge?: ChargeRole } | string {
  switch (spec.kind) {
    case "phantom_charge":
    case "outside_window_charge": {
      const refund = bindRefund(manifest, spec.refund);
      if (typeof refund === "string") return refund;
      const role = spec.kind === "phantom_charge" ? "phantom" : "control";
      const created =
        spec.kind === "phantom_charge"
          ? refund.windowStart + spec.createdOffsetSec
          : refund.windowEnd + spec.createdOffsetFromEndSec;
      if (
        !Number.isInteger(
          spec.kind === "phantom_charge" ? spec.createdOffsetSec : spec.createdOffsetFromEndSec,
        )
      ) {
        return "a charge offset must be a whole number of seconds";
      }
      const inside = created >= refund.windowStart && created < refund.windowEnd;
      if (role === "phantom" && !inside) {
        return "the phantom charge would fall outside the cited window";
      }
      if (role === "control" && inside) {
        return "the control charge would fall inside the cited window";
      }
      const id = derivedChargeId(role, definitionKey(spec), refund);
      if (id === refund.action.args.chargeId || refund.query.matchingIds.includes(id)) {
        return `derived charge ${id} collides with the plan's evidence`;
      }
      const charge: ChargeRole = {
        role,
        queryId: refund.query.id,
        charge: {
          id,
          customerId: refund.customerId,
          amountMinor: refund.amountMinor,
          currency: refund.currency,
          created,
        },
      };
      return {
        charge,
        challenge: {
          kind: "inject_charge",
          role,
          when: "before_run",
          vendor: "stripe",
          queryId: refund.query.id,
          charge: charge.charge,
        },
      };
    }
    case "fail_step": {
      const action = findAction(manifest.actions, spec.step);
      if (typeof action === "string") return action;
      const expected = steps.find((s) => s.actionId === action.id);
      if (expected?.outcome !== "rejected") {
        return `${action.id} is failed by the challenge but expected ${expected?.outcome ?? "absent"}`;
      }
      return { challenge: { kind: "fail_step", when: "during_run", actionId: action.id } };
    }
    case "teammate_field_edit": {
      const patch = findAction(manifest.actions, spec.patch);
      if (typeof patch === "string") return patch;
      if (patch.kind !== "zendesk.ticket.patchFields") return "a teammate edit names a patch";
      const after = findAction(manifest.actions, spec.afterFailedStep);
      if (typeof after === "string") return after;
      if (patch.args.set.priority === spec.value || patch.args.before.priority === spec.value) {
        return "the teammate priority equals a value the plan already uses";
      }
      if (after.kind !== "zendesk.ticket.appendPrivateNote") {
        return "the edit waits on a private note";
      }
      if (after.args.ticketId !== patch.args.ticketId) {
        return "the failed note is on a different ticket from the patch";
      }
      if (!/^[\w-]+$/.test(patch.args.ticketId)) {
        return "the ticket id is not a single path segment";
      }
      const expected = steps.find((s) => s.actionId === after.id);
      if (expected?.outcome !== "rejected") {
        return `${after.id} must be expected rejected before the teammate edit`;
      }
      return {
        challenge: {
          kind: "teammate_field_edit",
          when: { afterActionId: after.id, outcome: "rejected", before: "compensation" },
          vendor: "zendesk",
          ticketId: patch.args.ticketId,
          field: "priority",
          value: spec.value,
        },
      };
    }
    case "drop_response_after_commit": {
      const action = findAction(manifest.actions, spec.step);
      if (typeof action === "string") return action;
      const expected = steps.find((s) => s.actionId === action.id);
      if (expected?.outcome !== "confirmed") {
        return `${action.id} is dropped and must be expected confirmed once it is read back`;
      }
      return {
        challenge: {
          kind: "drop_response_after_commit",
          when: "during_run",
          actionId: action.id,
          thenRestart: true,
        },
      };
    }
  }
}

function definitionKey(spec: ChallengeSpec): string {
  return spec.kind;
}

function bindEffect(
  manifest: Evidence,
  spec: Exclude<EffectSpec, { kind: "other_refunds_once" }>,
  charges: ReadonlyMap<"phantom" | "control", ChargeRole>,
): ResolvedEffect | string {
  switch (spec.kind) {
    case "query_membership": {
      const refund = bindRefund(manifest, spec.refund);
      if (typeof refund === "string") return refund;
      const charge = charges.get(spec.role);
      if (!charge || charge.queryId !== refund.query.id) {
        return `no ${spec.role} charge was injected into ${refund.query.id}`;
      }
      return {
        kind: "query_membership",
        queryId: refund.query.id,
        chargeId: charge.charge.id,
        member: spec.member,
      };
    }
    case "refund_count": {
      const refund = bindRefund(manifest, spec.refund);
      if (typeof refund === "string") return refund;
      return {
        kind: "refund_count",
        actionId: refund.action.id,
        chargeId: refund.action.args.chargeId,
        count: spec.count,
      };
    }
    case "ticket_field": {
      const patch = findAction(manifest.actions, spec.patch);
      if (typeof patch === "string") return patch;
      if (patch.kind !== "zendesk.ticket.patchFields") return "a ticket effect names a patch";
      return {
        kind: "ticket_field",
        actionId: patch.id,
        ticketId: patch.args.ticketId,
        field: "priority",
        value: "urgent",
      };
    }
  }
}

function bindRefund(manifest: Evidence, selector: StepSelector): RefundBinding | string {
  const action = findAction(manifest.actions, selector);
  if (typeof action === "string") return action;
  if (action.kind !== "stripe.refund.create") return `${selector.kind} is not a refund`;
  const observation = manifest.observations.find(
    (o) =>
      action.evidence.includes(o.id) &&
      o.entity.vendor === "stripe" &&
      o.entity.kind === "charge" &&
      o.entity.id === action.args.chargeId,
  );
  if (!observation) return `${action.id} cites no observation of ${action.args.chargeId}`;
  const customerId = observation.projection.customer;
  const amountMinor = observation.projection.amount;
  const currency = observation.projection.currency;
  if (typeof customerId !== "string" || customerId.length === 0) {
    return `${observation.id} has no customer`;
  }
  if (typeof amountMinor !== "number" || !Number.isInteger(amountMinor) || amountMinor < 0) {
    return `${observation.id} amount is not an integer number of minor units`;
  }
  if (typeof currency !== "string" || !/^[a-z]{3}$/.test(currency)) {
    return `${observation.id} has no currency`;
  }
  const cited = manifest.queryObservations.filter((q) => action.queryEvidence.includes(q.id));
  const windows = cited.filter(
    (q): q is RefundBinding["query"] => q.predicate.kind === "stripe.charges.byCustomerInWindow",
  );
  if (windows.length !== 1) return `${action.id} must cite one customer window query`;
  const query = windows[0];
  if (!query) return `${action.id} must cite one customer window query`;
  if (!query.complete) return `${query.id} is incomplete`;
  if (query.predicate.customerId !== customerId) {
    return `${query.id} names a different customer from ${observation.id}`;
  }
  const windowStart = unix(query.predicate.createdGte);
  const windowEnd = unix(query.predicate.createdLt);
  if (windowStart === null || windowEnd === null || windowEnd <= windowStart) {
    return `${query.id} has a window that cannot be placed on a timeline`;
  }
  return { action, query, customerId, amountMinor, currency, windowStart, windowEnd };
}

function findAction(actions: readonly Action[], selector: StepSelector): Action | string {
  const caseIds: string[] = [];
  for (const action of actions) {
    if (!caseIds.includes(action.caseId)) caseIds.push(action.caseId);
  }
  const caseId = caseIds[selector.caseOrdinal];
  if (!caseId) return `the plan has no case ${selector.caseOrdinal}`;
  const found = actions.filter((a) => a.caseId === caseId && a.kind === selector.kind);
  if (found.length !== 1) {
    return `case ${selector.caseOrdinal} has ${found.length} ${selector.kind} steps`;
  }
  const action = found[0];
  if (!action) return `case ${selector.caseOrdinal} has no ${selector.kind} step`;
  return action;
}

function derivedChargeId(role: "phantom" | "control", kind: string, refund: RefundBinding): string {
  const suffix = fingerprint({
    role,
    kind,
    queryId: refund.query.id,
    customerId: refund.customerId,
  }).slice(0, 14);
  return `ch_rh${role === "phantom" ? "p" : "c"}${suffix}`;
}

function unix(iso: string): number | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

export type ChallengeOperation =
  | {
      kind: "inject_records";
      when: "before_run";
      vendor: "stripe";
      path: "/inject";
      charges: ResolvedCharge[];
    }
  | {
      kind: "vendor_write";
      when: { afterActionId: string; outcome: "rejected"; before: "compensation" };
      vendor: "zendesk";
      method: "PUT";
      path: string;
      body: { ticket: { priority: "urgent" } };
    }
  | {
      kind: "runner_transport";
      when: "during_run";
      mode: "fail_step" | "drop_response_after_commit";
      actionId: string;
      thenRestart: boolean;
    };

/**
 * The calls a resolved scenario implies. Inject is one tenant-scoped body. A ticket edit is one
 * field. Transport modes name a step and carry no fault JSON. There is no reset and no
 * `/_admin/faults`.
 */
export function challengeOperations(scenario: ResolvedScenario): ChallengeOperation[] {
  const ops: ChallengeOperation[] = [];
  const charges = scenario.challenges.flatMap((c) =>
    c.kind === "inject_charge" ? [c.charge] : [],
  );
  if (charges.length > 0) {
    ops.push({
      kind: "inject_records",
      when: "before_run",
      vendor: "stripe",
      path: "/inject",
      charges,
    });
  }
  for (const challenge of scenario.challenges) {
    switch (challenge.kind) {
      case "inject_charge":
        break;
      case "teammate_field_edit":
        ops.push({
          kind: "vendor_write",
          when: challenge.when,
          vendor: "zendesk",
          method: "PUT",
          path: `/api/v2/tickets/${challenge.ticketId}.json`,
          body: { ticket: { priority: challenge.value } },
        });
        break;
      case "fail_step":
        ops.push({
          kind: "runner_transport",
          when: "during_run",
          mode: "fail_step",
          actionId: challenge.actionId,
          thenRestart: false,
        });
        break;
      case "drop_response_after_commit":
        ops.push({
          kind: "runner_transport",
          when: "during_run",
          mode: "drop_response_after_commit",
          actionId: challenge.actionId,
          thenRestart: true,
        });
        break;
    }
  }
  return ops;
}

/**
 * Overlay a charge onto an Era inject template. The id, customer, amount, currency and created
 * time come from the resolved challenge; the template cannot keep its own.
 */
export function injectChargeRecord(
  template: Record<string, unknown>,
  charge: ResolvedCharge,
): Record<string, unknown> {
  const suffix = charge.id.startsWith("ch_") ? charge.id.slice(3) : charge.id;
  return {
    ...template,
    id: charge.id,
    customer: charge.customerId,
    amount: charge.amountMinor,
    amount_captured: charge.amountMinor,
    amount_refunded: 0,
    currency: charge.currency,
    status: "succeeded",
    created: charge.created,
    refunded: false,
    captured: true,
    paid: true,
    payment_intent: `pi_${suffix}`,
    balance_transaction: `txn_${suffix}`,
    receipt_url: `https://pay.stripe.com/receipts/sim/${charge.id}`,
    metadata: {},
    refunds: { object: "list", data: [], has_more: false, url: `/v1/charges/${charge.id}/refunds` },
  };
}

/**
 * A challenge may name only its own rehearsal tenant, on an endpoint no shared world uses.
 * `endpoint` and `sharedEndpoints` are `host:port` with loopback spellings already folded.
 */
export function assertRehearsalChallengeTarget(input: {
  rehearsalId: string;
  tenant: string;
  endpoint: string;
  sharedEndpoints: readonly string[];
}): void {
  if (!/^[a-z0-9]{8,32}$/.test(input.rehearsalId)) {
    throw new Error("a challenge names a server-chosen rehearsal id");
  }
  if (input.tenant !== rehearsalTenant(input.rehearsalId)) {
    throw new Error(`a challenge stays in ${rehearsalTenant(input.rehearsalId)}`);
  }
  if (input.sharedEndpoints.includes(input.endpoint)) {
    throw new Error("a challenge refuses an endpoint a planning or operational world uses");
  }
}
