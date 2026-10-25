import type { PlanManifest } from "@rehearsal/contracts";
import type { BillingPolicy } from "@rehearsal/core";
import type { PlanningSession, PlanningSessionOptions } from "@rehearsal/planner";
import { INCIDENT, type SeededCase } from "@rehearsal/testkit";
import policyV1 from "../../../scenarios/billing/policy.v1.json" with { type: "json" };
import policyV2 from "../../../scenarios/billing/policy.v2.json" with { type: "json" };
import type { Proposed } from "./score";
import type { CaseKey, Priority, ScorecardTask } from "./tasks";

/**
 * The scorecard's planner: a scripted agent with fixed rules, so every mode gets exactly the same
 * plan from the same planning-world reads and the comparison measures the apply side only. It
 * reads through the typed planning tools like the model would, and follows the billing policy on
 * its own (CAD only, same invoice, earliest charge kept). A task's `careless` entries make it break
 * those rules on purpose.
 *
 * Every write it decides on is an Intent. Rehearsal keeps the ones the planning tools accept as the
 * plan; direct mode sends all of them; per-call approval sends the ones a reviewer would pass.
 *
 * T1.27: with the task's ops on, it settles the listed cases with a balance credit instead of a
 * refund, sends a public reply after each refund, and ends with one Slack run summary.
 */

export const AGENT_ID = "scripted-rules";
export const AGENT_VERSION = "scorecard-agent.v2";

/** The Slack channel the run summary goes to (Era's seeded #general). */
export const SUMMARY_CHANNEL = "chan-general";

/** Policy v2 adds the invoice-credit limit; a task without credits plans under v1 as before. */
export function policyFor(task: ScorecardTask): BillingPolicy {
  return (task.ops.credits.length > 0 ? policyV2 : policyV1) as BillingPolicy;
}

export const POLICIES = [policyV1, policyV2] as BillingPolicy[];

/** What the server turns on for the task's planning session. Without an op, its tool refuses. */
export function sessionOps(
  task: ScorecardTask,
): Pick<PlanningSessionOptions, "credits" | "customerNames" | "runSummary"> {
  return {
    ...(task.ops.credits.length > 0 && { credits: true }),
    ...(task.ops.replies && {
      customerNames: Object.fromEntries(INCIDENT.cases.map((c) => [c.customerId, c.name])),
    }),
    ...(task.ops.summary && {
      runSummary: { channelId: SUMMARY_CHANNEL, incidentId: INCIDENT.incident },
    }),
  };
}

interface Charge {
  id: string;
  customer: string;
  amount: number;
  currency: string;
  invoice: string | null;
  created: number;
}

interface Ticket {
  id: number;
  priority: Priority | null;
  status: string;
  external_id: string | null;
}

type PairInput = { chargeId: string; duplicateOfChargeId: string; rationale: string };

/** One write the agent decided on, with the facts it read, which direct mode needs to send it. */
export type Intent = { caseKey: string } & (
  | {
      tool: "propose_duplicate_refund";
      input: PairInput;
      amountMinor: number;
      currency: string;
    }
  | {
      tool: "propose_balance_credit";
      input: PairInput;
      customerId: string;
      amountMinor: number;
      currency: string;
    }
  | {
      tool: "propose_ticket_priority";
      input: { customerId: string; ticketId: string; priority: Priority; rationale: string };
      before: { priority: Priority | null; status: string };
    }
  | {
      tool: "propose_refund_note";
      input: { refundStepId: string; ticketId: string };
      amountMinor: number;
    }
  | {
      tool: "propose_customer_reply";
      input: { refundStepId: string; ticketId: string };
      customerName: string;
      amountMinor: number;
    }
  | {
      tool: "propose_run_summary";
      input: Record<string, never>;
      channelId: string;
      incidentId: string;
    }
);

export interface DecidedIntent {
  intent: Intent;
  /** Whether the planning tools accepted it into the plan, and why not. */
  accepted: boolean;
  refusal?: string;
}

export interface AgentResult {
  intents: DecidedIntent[];
  manifest: PlanManifest;
}

/** The step ID the planning tools give the intent's action; direct mode uses the same. */
export function stepIdOf(intent: Intent): string {
  switch (intent.tool) {
    case "propose_duplicate_refund":
      return `refund_${intent.input.chargeId}`;
    case "propose_balance_credit":
      return `credit_${intent.input.chargeId}`;
    case "propose_ticket_priority":
      return `patch_${intent.input.ticketId}`;
    case "propose_refund_note":
      return `note_${intent.input.refundStepId}`;
    case "propose_customer_reply":
      return `reply_${intent.input.refundStepId}`;
    case "propose_run_summary":
      return "run_summary";
  }
}

const FIELD: Record<Intent["tool"], keyof Proposed | null> = {
  propose_duplicate_refund: "refunds",
  propose_balance_credit: "credits",
  propose_ticket_priority: "priority",
  propose_refund_note: "notes",
  propose_customer_reply: "replies",
  propose_run_summary: null,
};

/** Per case, how many of each effect the agent proposed, accepted or refused. */
export function proposedByCase(
  decided: readonly DecidedIntent[],
  keys: Iterable<CaseKey>,
): Record<CaseKey, Proposed> {
  const out: Record<CaseKey, Proposed> = {};
  for (const key of keys) out[key] = { refunds: 0, credits: 0, priority: 0, notes: 0, replies: 0 };
  for (const { intent } of decided) {
    const field = FIELD[intent.tool];
    const counts = out[intent.caseKey];
    if (field && counts) counts[field]++;
  }
  return out;
}

export async function runAgent(
  task: ScorecardTask,
  cases: readonly SeededCase[],
  session: PlanningSession,
  meta: { orgId: string; incidentId: string; planId: string; adapters: Record<string, string> },
): Promise<AgentResult> {
  const decided: DecidedIntent[] = [];
  const propose = async (intent: Intent) => {
    const res = await session.call(intent.tool, intent.input);
    decided.push(
      res.ok ? { intent, accepted: true } : { intent, accepted: false, refusal: res.error },
    );
  };
  const read = async <T>(tool: string, input: unknown): Promise<T> => {
    const res = await session.call(tool, input);
    if (!res.ok) throw new Error(`${tool} ${JSON.stringify(input)}: ${res.error}`);
    return res.result as T;
  };

  for (const c of cases) {
    const careless = task.careless.filter((x) => x.caseKey === c.key);
    if (!task.scope.includes(c.key) && careless.length === 0) continue;
    if (careless.some((x) => x.kind === "omit")) continue;

    // Refunds: the rules, then the deliberate mistakes.
    const refunds: Array<{ charge: Charge; original: Charge }> = [];
    const { records } = await read<{ records: Charge[] }>("list_customer_charges", {
      customerId: c.customerId,
    });
    for (const group of byInvoice(records)) {
      const [original, ...extra] = group;
      if (original?.currency !== "cad") continue;
      for (const charge of extra) {
        if (charge.amount === original.amount) refunds.push({ charge, original });
      }
    }
    for (const mistake of careless) {
      if (mistake.kind !== "refund_control" && mistake.kind !== "refund_both") continue;
      const [a, b] = await Promise.all(
        c.chargeIds.map((chargeId) => read<Charge>("get_charge", { chargeId })),
      );
      if (!a || !b) continue;
      if (mistake.kind === "refund_control") refunds.push({ charge: b, original: a });
      if (mistake.kind === "refund_both") refunds.push({ charge: a, original: b });
    }
    if (refunds.length === 0) continue;

    // The case's remedy: a balance credit where the task turns it on, else a refund (or both, by mistake).
    const credit = task.ops.credits.includes(c.key);
    const both = careless.some((x) => x.kind === "credit_and_refund");
    const refunded: Charge[] = [];
    for (const { charge, original } of refunds) {
      const input = {
        chargeId: charge.id,
        duplicateOfChargeId: original.id,
        rationale: `${charge.id} repeats ${original.id} for invoice ${original.invoice}.`,
      };
      if (credit) {
        await propose({
          caseKey: c.key,
          tool: "propose_balance_credit",
          input,
          customerId: c.customerId,
          amountMinor: charge.amount,
          currency: charge.currency,
        });
      }
      if (!credit || both) {
        await propose({
          caseKey: c.key,
          tool: "propose_duplicate_refund",
          input,
          amountMinor: charge.amount,
          currency: charge.currency,
        });
        refunded.push(charge);
      }
    }

    // The customer's own ticket: the one whose external_id names them.
    const { records: tickets } = await read<{ records: Ticket[] }>("list_requester_tickets", {
      requesterId: String(c.requesterId),
    });
    const ticket = tickets.find((t) => t.external_id === c.customerId && t.status !== "closed");
    if (!ticket) continue;
    const ticketId = String(ticket.id);
    await propose({
      caseKey: c.key,
      tool: "propose_ticket_priority",
      input: {
        customerId: c.customerId,
        ticketId,
        priority: "high",
        rationale: "Billing error confirmed; refund in progress.",
      },
      before: { priority: ticket.priority, status: ticket.status },
    });
    for (const charge of refunded) {
      await propose({
        caseKey: c.key,
        tool: "propose_refund_note",
        input: { refundStepId: `refund_${charge.id}`, ticketId },
        amountMinor: charge.amount,
      });
    }
    if (task.ops.replies) {
      for (const charge of refunded) {
        await propose({
          caseKey: c.key,
          tool: "propose_customer_reply",
          input: { refundStepId: `refund_${charge.id}`, ticketId },
          customerName: c.name,
          amountMinor: charge.amount,
        });
      }
    }
  }

  // One summary after every other step, and only when there is a refund to sum up.
  if (task.ops.summary && decided.some((d) => d.intent.tool === "propose_duplicate_refund")) {
    await propose({
      caseKey: "run",
      tool: "propose_run_summary",
      input: {},
      channelId: SUMMARY_CHANNEL,
      incidentId: INCIDENT.incident,
    });
  }

  return {
    intents: decided,
    manifest: session.manifest({
      ...meta,
      model: AGENT_ID,
      promptVersion: AGENT_VERSION,
    }),
  };
}

/** Charges grouped by invoice, each group oldest first. Charges with no invoice are skipped. */
function byInvoice(charges: readonly Charge[]): Charge[][] {
  const groups = new Map<string, Charge[]>();
  for (const charge of charges) {
    if (!charge.invoice) continue;
    groups.set(charge.invoice, [...(groups.get(charge.invoice) ?? []), charge]);
  }
  return [...groups.values()].map((g) =>
    [...g].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id)),
  );
}
