import {
  Action,
  type EntityRef,
  type Observation,
  type PlanManifest,
  type QueryObservation,
  type Role,
  ZendeskPriority,
  ZendeskStatus,
} from "@rehearsal/contracts";
import {
  type BillingPolicyV1,
  type Clock,
  fingerprint,
  type ProviderPort,
  type WorldContext,
} from "@rehearsal/core";
import { z } from "zod";

/**
 * T1.4: the typed tools the planner model may call. Every tool reads the planning world itself
 * and records exactly what it exposed as evidence. The propose_* tools build the action, its
 * evidence references, its dependency edges, its required role and its compensation class from
 * those reads. The model only picks IDs and writes a rationale: it can't name a URL, tenant,
 * method or field outside the typed vocabulary, and it can't define its own evidence.
 */

/** The read half of a ProviderPort (structurally the same as `ProviderReader` in providers). */
export type PlanningReader = Pick<ProviderPort, "vendor" | "observe" | "query">;

export interface PlanningSessionOptions {
  readers: { stripe: PlanningReader; zendesk: PlanningReader };
  /** Must be the planning world. The server picks it; the model never sees it. */
  ctx: WorldContext;
  policy: BillingPolicyV1;
  /** The incident predicate's window. Fixed by the incident, not chosen by the model. */
  window: { createdGte: string; createdLt: string };
  clock?: Clock;
}

const ChargeId = z.string().regex(/^ch_[A-Za-z0-9_]+$/, "a Stripe charge ID (ch_…)");
const CustomerId = z.string().regex(/^cus_[A-Za-z0-9_]+$/, "a Stripe customer ID (cus_…)");
const TicketId = z.string().regex(/^\d+$/, "a numeric Zendesk ticket ID");
const UserId = z.string().regex(/^\d+$/, "a numeric Zendesk user ID");
const Rationale = z.string().min(1).max(500).describe("Why, for the reviewer. Shown verbatim.");

/** Input schemas. Strict, so an extra field (a URL, a tenant, a header) is a validation error. */
export const PLANNING_TOOLS = {
  get_charge: {
    description: "Read one Stripe charge in the planning world.",
    input: z.strictObject({ chargeId: ChargeId }),
  },
  list_customer_charges: {
    description:
      "List every charge of one Stripe customer created inside the incident window. Reports whether every page was read.",
    input: z.strictObject({ customerId: CustomerId }),
  },
  get_ticket: {
    description: "Read one Zendesk ticket (priority, status, requester) in the planning world.",
    input: z.strictObject({ ticketId: TicketId }),
  },
  list_requester_tickets: {
    description: "List every Zendesk ticket requested by one user.",
    input: z.strictObject({ requesterId: UserId }),
  },
  propose_duplicate_refund: {
    description:
      "Propose a full refund of `chargeId`, which duplicates `duplicateOfChargeId` (same customer, amount and currency, both inside the incident window). The tool checks this against fresh reads and sets the required role from policy.",
    input: z.strictObject({
      chargeId: ChargeId,
      duplicateOfChargeId: ChargeId,
      rationale: Rationale,
    }),
  },
  propose_ticket_priority: {
    description:
      "Propose changing the priority of the customer's ticket. The customer must already have a proposed refund.",
    input: z.strictObject({
      customerId: CustomerId,
      ticketId: TicketId,
      priority: ZendeskPriority,
      rationale: Rationale,
    }),
  },
  propose_refund_note: {
    description:
      "Propose a private note on the ticket confirming a proposed refund. The note is rendered from the approved refund-confirmed template after the refund succeeds; you don't write its text.",
    input: z.strictObject({ refundStepId: z.string().min(1), ticketId: TicketId }),
  },
} as const;

export type PlanningToolName = keyof typeof PLANNING_TOOLS;
export type ToolInput<N extends PlanningToolName> = z.infer<(typeof PLANNING_TOOLS)[N]["input"]>;

/** Tool definitions in the Anthropic `tools` shape. */
export function planningToolDefinitions() {
  return Object.entries(PLANNING_TOOLS).map(([name, t]) => ({
    name,
    description: t.description,
    input_schema: z.toJSONSchema(t.input),
  }));
}

/** Recorded in every manifest, so a plan says exactly which tool surface produced it. */
export const TOOL_SCHEMA_HASH = fingerprint(planningToolDefinitions());

export type ToolResult = { ok: true; result: unknown } | { ok: false; error: string };

/** A refusal the model should see and can recover from (as opposed to a bug). */
class Refusal extends Error {}

const NOTE_TEMPLATE = { id: "refund-confirmed", version: 1 } as const;

export class PlanningSession {
  readonly #opts: PlanningSessionOptions;
  readonly #observations = new Map<string, Observation>();
  readonly #queries = new Map<string, QueryObservation>();
  readonly #actions: Action[] = [];

  constructor(opts: PlanningSessionOptions) {
    if (opts.ctx.world !== "planning") {
      throw new Error(`planning tools only read the planning world, not ${opts.ctx.world}`);
    }
    this.#opts = opts;
  }

  /** Run one tool call. Bad input and refusals come back as errors the model can read. */
  async call(name: string, input: unknown): Promise<ToolResult> {
    if (!Object.hasOwn(PLANNING_TOOLS, name)) return { ok: false, error: `unknown tool ${name}` };
    const parsed = PLANNING_TOOLS[name as PlanningToolName].input.safeParse(input);
    if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
    try {
      return { ok: true, result: await this.#run(name as PlanningToolName, parsed.data) };
    } catch (e) {
      if (e instanceof Refusal) return { ok: false, error: e.message };
      // A failed read is reported, never papered over; the evidence simply isn't recorded.
      return { ok: false, error: `read failed: ${(e as Error).message}` };
    }
  }

  get observations(): Observation[] {
    return structuredClone([...this.#observations.values()]);
  }
  get queryObservations(): QueryObservation[] {
    return structuredClone([...this.#queries.values()]);
  }
  get actions(): Action[] {
    return structuredClone(this.#actions);
  }

  /** The recorded evidence and proposed actions as a revision-1 manifest. */
  manifest(meta: {
    orgId: string;
    incidentId: string;
    planId: string;
    model: string;
    promptVersion: string;
    adapters: Record<string, string>;
  }): PlanManifest {
    return {
      schemaVersion: 1,
      orgId: meta.orgId,
      incidentId: meta.incidentId,
      planId: meta.planId,
      revision: 1,
      parentRevision: null,
      target: { environment: "operational" },
      versions: {
        planner: {
          model: meta.model,
          promptVersion: meta.promptVersion,
          toolSchemaHash: TOOL_SCHEMA_HASH,
        },
        adapters: meta.adapters,
      },
      policies: [{ id: this.#opts.policy.id, version: this.#opts.policy.version }],
      observations: this.observations,
      queryObservations: this.queryObservations,
      actions: this.actions,
      excluded: [],
    };
  }

  async #run(name: PlanningToolName, input: unknown): Promise<unknown> {
    const as = <N extends PlanningToolName>(_: N) => input as ToolInput<N>;
    switch (name) {
      case "get_charge": {
        const { chargeId } = as(name);
        return view(await this.#observe({ vendor: "stripe", kind: "charge", id: chargeId }));
      }
      case "list_customer_charges":
        return queryView(await this.#customerCharges(as(name).customerId));
      case "get_ticket": {
        const { ticketId } = as(name);
        return view(await this.#observe({ vendor: "zendesk", kind: "ticket", id: ticketId }));
      }
      case "list_requester_tickets":
        return queryView(
          await this.#record(
            this.#opts.readers.zendesk.query(
              { kind: "zendesk.tickets.byRequester", requesterId: as(name).requesterId },
              this.#now(),
              this.#opts.ctx,
            ),
          ),
        );
      case "propose_duplicate_refund": {
        const i = as(name);
        return this.#proposeRefund(i.chargeId, i.duplicateOfChargeId, i.rationale);
      }
      case "propose_ticket_priority": {
        const i = as(name);
        return this.#proposePriority(i.customerId, i.ticketId, i.priority, i.rationale);
      }
      case "propose_refund_note": {
        const i = as(name);
        return this.#proposeNote(i.refundStepId, i.ticketId);
      }
    }
  }

  #now(): string {
    return (this.#opts.clock?.now() ?? new Date()).toISOString();
  }

  async #observe(entity: EntityRef): Promise<Observation> {
    const reader =
      entity.vendor === "stripe" ? this.#opts.readers.stripe : this.#opts.readers.zendesk;
    const obs = await reader.observe(entity, this.#opts.ctx);
    if (obs.world !== "planning") throw new Error(`reader returned a ${obs.world} observation`);
    return this.#snapshot(this.#observations, obs);
  }

  async #record(pending: Promise<QueryObservation>): Promise<QueryObservation> {
    const q = await pending;
    if (q.world !== "planning") throw new Error(`reader returned a ${q.world} query`);
    return this.#snapshot(this.#queries, q);
  }

  /** Existing actions keep their evidence forever; a changed read creates another snapshot. */
  #snapshot<T extends { id: string; capturedAt: string }>(store: Map<string, T>, value: T): T {
    const semantic = (v: T) => fingerprint({ ...v, id: undefined, capturedAt: undefined });
    const first = store.get(value.id);
    const id =
      !first || semantic(first) === semantic(value) ? value.id : `${value.id}_${semantic(value)}`;
    let snapshot = store.get(id);
    if (!snapshot) {
      snapshot = structuredClone({ ...value, id });
      store.set(id, snapshot);
    }
    return structuredClone(snapshot);
  }

  #customerCharges(customerId: string): Promise<QueryObservation> {
    return this.#record(
      this.#opts.readers.stripe.query(
        { kind: "stripe.charges.byCustomerInWindow", customerId, ...this.#opts.window },
        this.#now(),
        this.#opts.ctx,
      ),
    );
  }

  #add(action: Action): Action {
    if (this.#actions.some((a) => a.id === action.id)) {
      throw new Refusal(`${action.id} is already proposed`);
    }
    // Contracts v1 is the gate: an action that doesn't parse never enters the plan.
    const parsed = Action.parse(action);
    this.#actions.push(parsed);
    return parsed;
  }

  async #proposeRefund(chargeId: string, duplicateOf: string, rationale: string) {
    if (chargeId === duplicateOf) throw new Refusal("a charge can't duplicate itself");
    const target = await this.#observe({ vendor: "stripe", kind: "charge", id: chargeId });
    const original = await this.#observe({ vendor: "stripe", kind: "charge", id: duplicateOf });
    const t = target.projection;
    const o = original.projection;
    const customer = String(t.customer);
    if (o.customer !== t.customer) {
      throw new Refusal(`${chargeId} and ${duplicateOf} belong to different customers`);
    }
    const population = await this.#customerCharges(customer);
    if (!population.complete) {
      throw new Refusal(`couldn't read every charge of ${customer}; try again`);
    }
    for (const id of [chargeId, duplicateOf]) {
      if (!population.matchingIds.includes(id)) {
        throw new Refusal(`${id} is not a charge of ${customer} inside the incident window`);
      }
    }
    if (t.amount !== o.amount || t.currency !== o.currency) {
      throw new Refusal(`not a duplicate: ${t.amount} ${t.currency} vs ${o.amount} ${o.currency}`);
    }
    const { policy } = this.#opts;
    if (t.currency !== policy.currency) {
      throw new Refusal(
        `policy ${policy.id}@${policy.version} refunds only ${policy.currency}; ${chargeId} is ${t.currency}. Leave it for a human.`,
      );
    }
    if (t.status !== "succeeded" || o.status !== "succeeded") {
      throw new Refusal("both charges must have succeeded");
    }
    if (t.amount_refunded !== 0 || o.amount_refunded !== 0) {
      throw new Refusal("one of these charges is already (partly) refunded");
    }
    if (typeof t.invoice !== "string" || !t.invoice || t.invoice !== o.invoice) {
      throw new Refusal("not a duplicate: both charges must identify the same invoice");
    }
    const amountMinor = Number(t.amount);
    // One obligation per duplicate pair, whichever charge of it gets refunded.
    const obligationId = `obl_duplicate_${[chargeId, duplicateOf].sort().join("_")}`;
    const prior = this.#actions.find(
      (a) =>
        a.kind === "stripe.refund.create" &&
        (a.obligationId === obligationId || a.args.chargeId === chargeId),
    );
    if (prior) throw new Refusal(`already remedied by ${prior.id}`);
    // Every excess charge of an invoice must point to the same paid original. Pair cycles
    // must never turn three payments into three refunds.
    const group = population.matchingIds
      .map((id) => population.projections[id])
      .filter((p) => p?.invoice === t.invoice);
    if (
      group.some(
        (p) =>
          !p ||
          p.customer !== customer ||
          p.currency !== t.currency ||
          p.amount !== t.amount ||
          p.status !== "succeeded" ||
          !Number.isSafeInteger(p.created) ||
          p.amount_refunded !== 0,
      )
    ) {
      throw new Refusal("invoice group is ambiguous or already refunded; leave it for a human");
    }
    const anchor = [...group].sort(
      (a, b) =>
        Number(a?.created) - Number(b?.created) || String(a?.id).localeCompare(String(b?.id)),
    )[0];
    if (anchor?.id !== duplicateOf || anchor.id === chargeId) {
      throw new Refusal("keep the invoice's earliest paid charge as the original");
    }
    const requiredRole: Role =
      amountMinor >= policy.financeThresholdMinor ? "finance_lead" : "support_lead";
    const action = this.#add({
      id: `refund_${chargeId}`,
      kind: "stripe.refund.create",
      caseId: `case_${customer}`,
      obligationId,
      dependsOn: [],
      requiredRole,
      evidence: [target.id, original.id],
      queryEvidence: [population.id],
      compensation: "compensable_by_new_action",
      protection: "native_guard_with_documented_limits",
      rationale,
      args: {
        chargeId,
        amount: { amountMinor, currency: policy.currency },
        reason: "duplicate",
      },
    });
    return summary(action);
  }

  async #proposePriority(
    customerId: string,
    ticketId: string,
    priority: z.infer<typeof ZendeskPriority>,
    rationale: string,
  ) {
    const caseId = `case_${customerId}`;
    const refund = this.#actions.find(
      (a) => a.caseId === caseId && a.kind === "stripe.refund.create",
    );
    if (!refund) throw new Refusal(`propose a refund for ${customerId} first`);
    const ticket = await this.#ticketForCustomer(ticketId, customerId);
    const current = ZendeskPriority.nullable().safeParse(ticket.projection.priority ?? null);
    if (!current.success) {
      throw new Refusal(`ticket ${ticketId} has an unexpected priority`);
    }
    if (current.data === priority) throw new Refusal(`ticket ${ticketId} is already ${priority}`);
    const status = ZendeskStatus.safeParse(ticket.projection.status);
    const action = this.#add({
      id: `patch_${ticketId}`,
      kind: "zendesk.ticket.patchFields",
      caseId,
      obligationId: refund.obligationId,
      dependsOn: [],
      requiredRole: "support_lead",
      evidence: [ticket.id],
      queryEvidence: [],
      compensation: "conditional_reversible",
      protection: "native_guard_with_documented_limits",
      rationale,
      args: {
        ticketId,
        set: { priority },
        before: { priority: current.data, ...(status.success && { status: status.data }) },
      },
    });
    return summary(action);
  }

  async #proposeNote(refundStepId: string, ticketId: string) {
    const refund = this.#actions.find((a) => a.id === refundStepId);
    if (refund?.kind !== "stripe.refund.create") {
      throw new Refusal(`${refundStepId} is not a proposed refund`);
    }
    const charge = this.observations.find(
      (o) =>
        refund.evidence.includes(o.id) &&
        o.entity.vendor === "stripe" &&
        o.entity.id === refund.args.chargeId,
    );
    if (typeof charge?.projection.customer !== "string") {
      throw new Refusal("refund customer evidence is missing");
    }
    const ticket = await this.#ticketForCustomer(ticketId, charge.projection.customer);
    const action = this.#add({
      id: `note_${refundStepId}`,
      kind: "zendesk.ticket.appendPrivateNote",
      caseId: refund.caseId,
      obligationId: refund.obligationId,
      // The note claims the refund happened, so it runs only after that refund is confirmed.
      dependsOn: [refund.id],
      requiredRole: "support_lead",
      evidence: [ticket.id],
      queryEvidence: [],
      compensation: "irreversible",
      protection: "no_atomic_guard",
      rationale: `Record refund ${refund.id} on ticket ${ticketId}.`,
      args: {
        ticketId,
        public: false,
        template: NOTE_TEMPLATE,
        bindings: {
          refundId: { $ref: "result", stepId: refund.id, path: "refund.id" },
          amountMinor: refund.args.amount.amountMinor,
        },
      },
    });
    return summary(action);
  }

  async #ticketForCustomer(ticketId: string, customerId: string): Promise<Observation> {
    const ticket = await this.#observe({ vendor: "zendesk", kind: "ticket", id: ticketId });
    if (ticket.projection.external_id !== customerId) {
      throw new Refusal(`ticket ${ticketId} is not verified as belonging to ${customerId}`);
    }
    return ticket;
  }
}

function view(obs: Observation) {
  return { evidenceId: obs.id, ...obs.projection };
}

function queryView(q: QueryObservation) {
  return {
    evidenceId: q.id,
    complete: q.complete,
    matchingIds: q.matchingIds,
    records: q.matchingIds.map((id) => q.projections[id]),
  };
}

function summary(a: Action) {
  return {
    actionId: a.id,
    kind: a.kind,
    caseId: a.caseId,
    requiredRole: a.requiredRole,
    dependsOn: a.dependsOn,
    evidence: [...a.evidence, ...a.queryEvidence],
  };
}
