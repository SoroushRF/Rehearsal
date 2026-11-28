import type { Attempt } from "@rehearsal/contracts";
import {
  type BillingPolicy,
  bindingKey,
  type DispatchResult,
  type ReconcileResult,
  sha256Hex,
  summaryCountKey,
} from "@rehearsal/core";
import { duplicateInvoiceGroup } from "@rehearsal/planner";
import { type DecidedIntent, type Intent, stepIdOf } from "./agent";
import { type ApplyResult, actionFor, type Contexts, type Ports, vendorOf } from "./modes";

/**
 * T1.25: a competent deterministic workflow, the strongest baseline without a plan or a reviewer.
 * It takes the same agent decisions as every other mode and, before each write, checks the world
 * as it is now with the same rules the planning tools apply:
 * - a refund or credit only for a duplicate that is still one (same customer, invoice, amount
 *   and currency, both succeeded and unrefunded, the invoice's earliest paid charge kept), in the
 *   policy's currency, with no refund or credit of that charge already made;
 * - a credit only below the policy's credit limit, on a balance kept in the policy's currency;
 * - a priority patch only while the ticket still has the priority the agent read, guarded by
 *   Zendesk's update stamp;
 * - a note or reply only after its remedy was confirmed in this run.
 * Each write has one durable idempotency key. A 429 is retried with the same bytes; a lost response
 * is settled by reading the provider (the operation marker), and re-sent only when the read shows
 * nothing landed. What it doesn't have: an approved snapshot to compare against. It acts on the
 * world as it is when it writes, so a change that keeps a duplicate valid (a third charge on the
 * invoice) doesn't stop it.
 */
export async function applyCompetent(
  decided: readonly DecidedIntent[],
  ports: Ports,
  ctx: Contexts,
  opts: {
    taskId: string;
    policy: BillingPolicy;
    /** The task's own incident window: the charge listing that finds an invoice's earliest charge. */
    window: { createdGte: string; createdLt: string };
  },
): Promise<ApplyResult> {
  const log: string[] = [];
  const outcomes = new Map<string, "confirmed" | "not_confirmed">();
  /** Remedy step → the refund ID it created (a credit yields none). */
  const remedies = new Map<string, string | null>();
  /** Charges remedied in this run: a second remedy for one is never sent. */
  const remediedCharges = new Set<string>();
  let unresolved = 0;

  const stripe = ports.stripe;
  const zendesk = ports.zendesk;
  if (!stripe || !zendesk || !ctx.stripe || !ctx.zendesk)
    throw new Error("no Stripe or Zendesk world");
  const stripeCtx = ctx.stripe;
  const zendeskCtx = ctx.zendesk;

  /** Why this intent must not be sent now, from fresh reads; null when it may. */
  const check = async (intent: Intent): Promise<string | null> => {
    switch (intent.tool) {
      case "propose_duplicate_refund":
      case "propose_balance_credit": {
        const { chargeId, duplicateOfChargeId } = intent.input;
        if (remediedCharges.has(chargeId)) return "this charge was already remedied in this run";
        const [t, o] = await Promise.all(
          [chargeId, duplicateOfChargeId].map(
            async (id) =>
              (await stripe.observe({ vendor: "stripe", kind: "charge", id }, stripeCtx))
                .projection,
          ),
        );
        if (!t || !o) return "charge not found";
        if (t.customer !== o.customer) return "the charges belong to different customers";
        if (t.amount !== o.amount || t.currency !== o.currency) return "not a duplicate";
        if (typeof t.invoice !== "string" || t.invoice !== o.invoice) return "not the same invoice";
        if (t.status !== "succeeded" || o.status !== "succeeded") return "a charge didn't succeed";
        if (t.amount_refunded !== 0 || o.amount_refunded !== 0) return "already (partly) refunded";
        if (t.currency !== opts.policy.currency)
          return `policy covers ${opts.policy.currency} only`;
        const customer = String(t.customer);
        const charges = await stripe.query(
          { kind: "stripe.charges.byCustomerInWindow", customerId: customer, ...opts.window },
          new Date().toISOString(),
          stripeCtx,
        );
        if (!charges.complete) return "couldn't list every charge of the customer";
        const group = duplicateInvoiceGroup(charges, t.invoice);
        if (
          !group ||
          group[0]?.id !== duplicateOfChargeId ||
          !group.some((g) => g?.id === chargeId)
        ) {
          return "the invoice's earliest paid charge isn't the original";
        }
        const credits = (
          await stripe.observe(
            { vendor: "stripe", kind: "customer_balance_transactions", id: customer },
            stripeCtx,
          )
        ).projection as { complete?: boolean; credits?: { chargeId: string | null }[] };
        if (!credits.complete) return "couldn't list the customer's credits";
        if (credits.credits?.some((c) => c.chargeId === chargeId)) return "already credited";
        if (intent.tool === "propose_balance_credit") {
          const limit = (opts.policy as { creditMaxMinor?: number }).creditMaxMinor;
          if (limit === undefined || Number(t.amount) >= limit) return "no credit at this amount";
          const account = (
            await stripe.observe({ vendor: "stripe", kind: "customer", id: customer }, stripeCtx)
          ).projection;
          if (account.currency !== null && account.currency !== opts.policy.currency) {
            return `the balance is kept in ${String(account.currency)}`;
          }
        }
        return null;
      }
      case "propose_ticket_priority": {
        const { ticketId, priority } = intent.input;
        const ticket = (
          await zendesk.observe({ vendor: "zendesk", kind: "ticket", id: ticketId }, zendeskCtx)
        ).projection;
        if (ticket.priority === priority) return `ticket ${ticketId} is already ${priority}`;
        if (ticket.priority !== intent.before.priority) {
          return `someone changed the priority to ${String(ticket.priority)}; leaving it`;
        }
        return null;
      }
      case "propose_refund_note":
      case "propose_customer_reply":
        return outcomes.get(intent.input.refundStepId) === "confirmed"
          ? null
          : "its remedy wasn't confirmed";
      case "propose_run_summary":
        return null;
    }
  };

  for (const { intent } of decided) {
    const stepId = stepIdOf(intent);
    const label = `${intent.tool} ${JSON.stringify(intent.input)}`;
    let why: string | null;
    try {
      why = await check(intent);
    } catch (e) {
      why = `read failed: ${(e as Error).message}`;
    }
    if (why) {
      outcomes.set(stepId, "not_confirmed");
      log.push(`checked and skipped (${why}): ${label}`);
      continue;
    }

    const action = actionFor(intent, decided);
    const bindings = new Map<string, string | number>();
    if (intent.tool === "propose_refund_note" || intent.tool === "propose_customer_reply") {
      const refundId = remedies.get(intent.input.refundStepId);
      if (refundId)
        bindings.set(
          bindingKey({ stepId: intent.input.refundStepId, path: "refund.id" }),
          refundId,
        );
    }
    if (action.kind === "slack.message.postSummary") {
      const steps = [...outcomes];
      bindings.set(
        summaryCountKey("refunded"),
        steps.filter(([id, o]) => id.startsWith("refund_") && o === "confirmed").length,
      );
      bindings.set(summaryCountKey("held"), steps.filter(([, o]) => o !== "confirmed").length);
    }

    const vendor = vendorOf(action);
    const port = ports[vendor];
    const context = ctx[vendor];
    if (!port || !context) throw new Error(`no ${vendor} world for ${label}`);
    // One key per step for the whole run: a re-send is the same operation, never a second one.
    const key = `op_competent_${opts.taskId}_${stepId}`;
    try {
      const pre = (await port.preconditions?.(action, context)) ?? {};
      const req = port.prepare(action, bindings, key, pre);
      let result: DispatchResult = await port.dispatch(req, context);
      for (let i = 0; i < 3 && result.kind === "rejected" && result.retryable; i++) {
        await sleep(result.retryAfterMs ?? 1000);
        result = await port.dispatch(req, context);
      }
      let effect: Record<string, unknown> | undefined =
        result.kind === "confirmed" ? (result.body as Record<string, unknown>) : undefined;
      if (result.kind === "unknown") {
        const at = new Date().toISOString();
        const attempt: Attempt = {
          id: `att_${stepId}`,
          actionId: stepId,
          planHash: "0".repeat(64),
          operationKey: key,
          attemptNo: 1,
          state: "unknown_outcome",
          request: {
            method: req.method,
            path: req.path,
            encoding: req.encoding,
            body: req.body,
            bodySha256: sha256Hex(req.body),
          },
          providerStatus: null,
          error: result.error,
          preparedAt: at,
          dispatchedAt: at,
          settledAt: null,
        };
        // Read before anything else: the write may have landed even though its answer didn't.
        const back: ReconcileResult = await port
          .reconcile(attempt, action, context)
          .catch((e: Error) => ({ kind: "indeterminate", detail: e.message }) as const);
        if (back.kind === "applied") {
          effect = back.effect;
          log.push(`lost response, read back as applied: ${label}`);
        } else if (back.kind === "not_applied") {
          result = await port.dispatch(req, context);
          if (result.kind === "confirmed") effect = result.body as Record<string, unknown>;
        }
      }
      if (effect === undefined) {
        outcomes.set(stepId, "not_confirmed");
        if (result.kind === "unknown") unresolved++;
        log.push(`${describe(result)}: ${label}`);
        continue;
      }
      outcomes.set(stepId, "confirmed");
      log.push(`confirmed: ${label}`);
      if (
        action.kind === "stripe.refund.create" ||
        action.kind === "stripe.customer.balanceCredit"
      ) {
        remediedCharges.add(action.args.chargeId);
        const id =
          effect["refund.id"] ?? (action.kind === "stripe.refund.create" ? effect.id : null);
        remedies.set(stepId, typeof id === "string" ? id : null);
      }
    } catch (e) {
      outcomes.set(stepId, "not_confirmed");
      log.push(`failed before sending (${(e as Error).message}): ${label}`);
    }
  }
  return { unresolved, reviewerActions: 0, promptOpportunities: 0, log };
}

function describe(r: DispatchResult): string {
  return r.kind === "unknown" ? "unknown" : `${r.kind} ${r.status}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
