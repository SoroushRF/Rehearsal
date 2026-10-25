import {
  Action,
  type EntityRef,
  type Observation,
  type PlanManifest,
  type PrecedentBasis,
  type QueryObservation,
  type Role,
  ZendeskPriority,
  ZendeskStatus,
} from "@rehearsal/contracts";
import {
  type BillingPolicy,
  type Clock,
  fingerprint,
  type ProviderPort,
  renderReply,
  type WorldContext,
} from "@rehearsal/core";
import { z } from "zod";
import { assessCoverage, duplicateInvoiceGroup } from "./coverage";

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
  policy: BillingPolicy;
  /** The incident predicate's window. Fixed by the incident, not chosen by the model. */
  window: { createdGte: string; createdLt: string };
  /**
   * Where the run summary goes (T1.7), chosen by the server; without it propose_run_summary
   * refuses. The incident ID is the summary's only literal.
   */
  runSummary?: { channelId: string; incidentId: string };
  /**
   * Customers' names from the incident report, by Stripe customer ID, for public replies (T1.13).
   * The server turns replies on by passing them; without a name propose_customer_reply refuses.
   * The name is the reply's only text that isn't the template's, and it never comes from the model.
   */
  customerNames?: Readonly<Record<string, string>>;
  /**
   * Invoice-balance credits as the remedy instead of a refund (T1.14). The server turns them on;
   * propose_balance_credit still refuses unless the policy has a credit limit (v2 and later).
   */
  credits?: boolean;
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
  propose_balance_credit: {
    description:
      "Propose crediting the customer's invoice balance with the amount of `chargeId`, which duplicates `duplicateOfChargeId`, instead of refunding it. Only for a small amount the policy lets you settle as credit; the money stays on the customer's account. It settles the same obligation as a refund of that charge, so propose one or the other, never both. The tool checks the pair and the customer's currency against fresh reads.",
    input: z.strictObject({
      chargeId: ChargeId,
      duplicateOfChargeId: ChargeId,
      rationale: Rationale,
    }),
  },
  propose_ticket_priority: {
    description:
      "Propose changing the priority of the customer's ticket. The customer must already have a proposed refund or balance credit.",
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
  propose_customer_reply: {
    description:
      "Propose a public reply on the customer's ticket telling them a proposed refund went out. The customer reads it. The text is the approved refund-issued template filled with their name from the incident report and the refund amount; you don't write it, and the reviewer approves the exact text. It's sent only after the refund succeeds.",
    input: z.strictObject({ refundStepId: z.string().min(1), ticketId: TicketId }),
  },
  propose_run_summary: {
    description:
      "Propose one Slack post to the team channel summarising the run: how many refunds went out and how many steps were held. Call it once, after every other step; it counts every step proposed so far, and no step can be proposed after it. The text is rendered from the approved run-summary template when the run finishes; you don't write it.",
    input: z.strictObject({}),
  },
} as const;

export type PlanningToolName = keyof typeof PLANNING_TOOLS;
export type ToolInput<N extends PlanningToolName> = z.infer<(typeof PLANNING_TOOLS)[N]["input"]>;

/**
 * Tool definitions in the Anthropic `tools` shape. The balance-credit tool is offered only to a
 * session with credits on (T1.14), so a refund-only run sees the same tools as before it existed.
 */
export function planningToolDefinitions(opts: { credits?: boolean } = {}) {
  return Object.entries(PLANNING_TOOLS)
    .filter(([name]) => opts.credits || name !== "propose_balance_credit")
    .map(([name, t]) => ({
      name,
      description: t.description,
      input_schema: z.toJSONSchema(t.input),
    }));
}

/** Recorded in every manifest, so a plan says exactly which tool surface produced it. */
export const TOOL_SCHEMA_HASH = fingerprint(planningToolDefinitions());
/** The same with propose_balance_credit offered. */
export const CREDIT_TOOL_SCHEMA_HASH = fingerprint(planningToolDefinitions({ credits: true }));

export type ToolResult = { ok: true; result: unknown } | { ok: false; error: string };

/** A refusal the model should see and can recover from (as opposed to a bug). */
class Refusal extends Error {}

const NOTE_TEMPLATE = { id: "refund-confirmed", version: 1 } as const;
const REPLY_TEMPLATE = { id: "refund-issued", version: 1 } as const;
const SUMMARY_TEMPLATE = { id: "run-summary", version: 1 } as const;
const SUMMARY_ID = "run_summary";

export class PlanningSession {
  readonly #opts: PlanningSessionOptions;
  readonly #observations = new Map<string, Observation>();
  readonly #queries = new Map<string, QueryObservation>();
  readonly #actions: Action[] = [];
  readonly #lastChargeQueries = new Map<string, QueryObservation>();

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

  coverage(customerIds: readonly string[]) {
    return assessCoverage(
      customerIds,
      [...this.#lastChargeQueries.values()],
      this.actions,
      this.#opts.policy,
    );
  }

  /** The tools this session offers the model. */
  toolDefinitions() {
    return planningToolDefinitions({ credits: this.#opts.credits });
  }

  /** The recorded evidence and proposed actions as a revision-1 manifest. */
  manifest(meta: {
    orgId: string;
    incidentId: string;
    planId: string;
    model: string;
    promptVersion: string;
    adapters: Record<string, string>;
    precedentBasis?: PrecedentBasis;
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
          toolSchemaHash: this.#opts.credits ? CREDIT_TOOL_SCHEMA_HASH : TOOL_SCHEMA_HASH,
        },
        adapters: meta.adapters,
      },
      policies: [{ id: this.#opts.policy.id, version: this.#opts.policy.version }],
      observations: this.observations,
      queryObservations: this.queryObservations,
      actions: this.actions,
      excluded: [],
      ...(meta.precedentBasis && { precedentBasis: meta.precedentBasis }),
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
      case "propose_balance_credit": {
        const i = as(name);
        return this.#proposeCredit(i.chargeId, i.duplicateOfChargeId, i.rationale);
      }
      case "propose_ticket_priority": {
        const i = as(name);
        return this.#proposePriority(i.customerId, i.ticketId, i.priority, i.rationale);
      }
      case "propose_refund_note": {
        const i = as(name);
        return this.#proposeNote(i.refundStepId, i.ticketId);
      }
      case "propose_customer_reply": {
        const i = as(name);
        return this.#proposeReply(i.refundStepId, i.ticketId);
      }
      case "propose_run_summary":
        return this.#proposeSummary();
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

  async #customerCharges(customerId: string): Promise<QueryObservation> {
    const query = await this.#record(
      this.#opts.readers.stripe.query(
        { kind: "stripe.charges.byCustomerInWindow", customerId, ...this.#opts.window },
        this.#now(),
        this.#opts.ctx,
      ),
    );
    this.#lastChargeQueries.set(customerId, query);
    return query;
  }

  #add(action: Action): Action {
    if (this.#actions.some((a) => a.id === action.id)) {
      throw new Refusal(`${action.id} is already proposed`);
    }
    if (this.#actions.some((a) => a.kind === "slack.message.postSummary")) {
      throw new Refusal("the run summary is already proposed; it has to be the last step");
    }
    // Contracts v1 is the gate: an action that doesn't parse never enters the plan.
    const parsed = Action.parse(action);
    this.#actions.push(parsed);
    return parsed;
  }

  /**
   * The checks every remedy of a duplicate shares: same customer, amount, currency and invoice, both
   * inside the window, nothing refunded yet, the invoice's earliest charge kept, and no remedy of
   * this obligation or charge proposed already.
   */
  async #duplicatePair(chargeId: string, duplicateOf: string) {
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
        (a.kind === "stripe.refund.create" || a.kind === "stripe.customer.balanceCredit") &&
        (a.obligationId === obligationId || a.args.chargeId === chargeId),
    );
    if (prior) throw new Refusal(`already remedied by ${prior.id}`);
    // Every excess charge of an invoice must point to the same paid original. Pair cycles
    // must never turn three payments into three refunds.
    const group = duplicateInvoiceGroup(population, t.invoice);
    if (!group || group[0]?.currency !== t.currency || group[0]?.amount !== t.amount) {
      throw new Refusal("invoice group is ambiguous or already refunded; leave it for a human");
    }
    const anchor = group[0];
    if (anchor?.id !== duplicateOf || anchor.id === chargeId) {
      throw new Refusal("keep the invoice's earliest paid charge as the original");
    }
    const requiredRole: Role =
      amountMinor >= policy.financeThresholdMinor ? "finance_lead" : "support_lead";
    return { target, original, population, customer, amountMinor, obligationId, requiredRole };
  }

  async #proposeRefund(chargeId: string, duplicateOf: string, rationale: string) {
    const { target, original, population, customer, amountMinor, obligationId, requiredRole } =
      await this.#duplicatePair(chargeId, duplicateOf);
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
        amount: { amountMinor, currency: this.#opts.policy.currency },
        reason: "duplicate",
      },
    });
    return summary(action);
  }

  async #proposeCredit(chargeId: string, duplicateOf: string, rationale: string) {
    const { policy } = this.#opts;
    if (!this.#opts.credits) throw new Refusal("balance credits are off; propose a refund");
    if (!("creditMaxMinor" in policy)) {
      throw new Refusal(
        `policy ${policy.id}@${policy.version} has no invoice credit; use a refund`,
      );
    }
    const { target, original, population, customer, amountMinor, obligationId, requiredRole } =
      await this.#duplicatePair(chargeId, duplicateOf);
    if (amountMinor >= policy.creditMaxMinor) {
      throw new Refusal(
        `a credit must be below ${policy.creditMaxMinor} ${policy.currency}; refund ${chargeId} instead`,
      );
    }
    // Era takes a credit in any currency; Stripe keeps a customer's balance in one (surprise 14).
    const account = await this.#observe({ vendor: "stripe", kind: "customer", id: customer });
    const currency = account.projection.currency;
    if (currency !== null && currency !== policy.currency) {
      throw new Refusal(
        `customer ${customer} is billed in ${String(currency)}, so a ${policy.currency} credit can't go on their balance; refund ${chargeId} instead`,
      );
    }
    const action = this.#add({
      id: `credit_${chargeId}`,
      kind: "stripe.customer.balanceCredit",
      caseId: `case_${customer}`,
      obligationId,
      dependsOn: [],
      requiredRole,
      evidence: [target.id, original.id, account.id],
      queryEvidence: [population.id],
      // A credit can't be deleted; only a new, separately approved debit offsets it.
      compensation: "compensable_by_new_action",
      protection: "native_guard_with_documented_limits",
      rationale,
      args: {
        customerId: customer,
        chargeId,
        amount: { amountMinor, currency: policy.currency },
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
      (a) =>
        a.caseId === caseId &&
        (a.kind === "stripe.refund.create" || a.kind === "stripe.customer.balanceCredit"),
    );
    if (!refund) throw new Refusal(`propose a refund or credit for ${customerId} first`);
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
    const { refund, customer } = this.#refundOf(refundStepId);
    const ticket = await this.#ticketForCustomer(ticketId, customer);
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

  async #proposeReply(refundStepId: string, ticketId: string) {
    const { refund, customer } = this.#refundOf(refundStepId);
    const name = this.#opts.customerNames?.[customer];
    if (name === undefined) {
      throw new Refusal(`customer replies aren't enabled for ${customer}; leave the reply out`);
    }
    const ticket = await this.#ticketForCustomer(ticketId, customer);
    const values = { customerName: name, amountMinor: refund.args.amount.amountMinor };
    let body: string;
    try {
      body = renderReply(REPLY_TEMPLATE, values);
    } catch (err) {
      throw new Refusal(`can't render the reply for ${customer}: ${(err as Error).message}`);
    }
    const action = this.#add({
      id: `reply_${refundStepId}`,
      kind: "zendesk.ticket.appendPublicReply",
      caseId: refund.caseId,
      obligationId: refund.obligationId,
      // The reply tells the customer the refund went out, so it waits for that refund's receipt.
      dependsOn: [refund.id],
      requiredRole: "support_lead",
      evidence: [ticket.id],
      queryEvidence: [],
      compensation: "irreversible",
      protection: "no_atomic_guard",
      rationale: `Tell the customer on ticket ${ticketId} that refund ${refund.id} went out.`,
      args: { ticketId, public: true, template: REPLY_TEMPLATE, values, body },
    });
    return { ...summary(action), body };
  }

  /** A proposed refund and its customer, from the charge evidence the refund cites. */
  #refundOf(refundStepId: string) {
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
    return { refund, customer: charge.projection.customer };
  }

  #proposeSummary() {
    const target = this.#opts.runSummary;
    if (!target) throw new Refusal("no run summary channel is configured; skip the summary");
    const steps = this.#actions.map((a) => a.id);
    const refunds = this.#actions.filter((a) => a.kind === "stripe.refund.create").map((a) => a.id);
    if (refunds.length === 0)
      throw new Refusal("no refund is proposed, so there is nothing to sum up");
    const action = this.#add({
      id: SUMMARY_ID,
      kind: "slack.message.postSummary",
      caseId: "run",
      obligationId: SUMMARY_ID,
      // It counts every step, so it runs after all of them, held or not.
      dependsOn: steps,
      requiredRole: "support_lead",
      evidence: [],
      queryEvidence: [],
      compensation: "irreversible",
      protection: "no_atomic_guard",
      rationale: `Tell ${target.channelId} how many refunds went out and how many steps were held.`,
      args: {
        channelId: target.channelId,
        template: SUMMARY_TEMPLATE,
        bindings: {
          incidentId: target.incidentId,
          refunded: { $count: "outcomes", stepIds: refunds, outcomes: ["confirmed"] },
          held: {
            $count: "outcomes",
            stepIds: steps,
            outcomes: ["held", "unknown_outcome", "rejected", "skipped_dependency"],
          },
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
