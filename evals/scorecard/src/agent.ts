import type { PlanManifest } from "@rehearsal/contracts";
import type { PlanningSession } from "@rehearsal/planner";
import type { SeededCase } from "@rehearsal/testkit";
import type { Priority, ScorecardTask } from "./tasks";

/**
 * The scorecard's planner: a scripted agent with fixed rules, so every mode gets exactly the same
 * plan from the same planning-world reads and the comparison measures the apply side only. It
 * reads through the typed planning tools like the model would, and follows the billing policy on
 * its own (CAD only, same invoice, earliest charge kept). A task's `careless` entries make it break
 * those rules on purpose.
 *
 * Every write it decides on is an Intent. Rehearsal keeps the ones the planning tools accept as the
 * plan; direct mode sends all of them; per-call approval sends the ones a reviewer would pass.
 */

export const AGENT_ID = "scripted-rules";
export const AGENT_VERSION = "scorecard-agent.v1";

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

/** One write the agent decided on, with the facts it read, which direct mode needs to send it. */
export type Intent = { caseKey: string } & (
  | {
      tool: "propose_duplicate_refund";
      input: { chargeId: string; duplicateOfChargeId: string; rationale: string };
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
      const [a, b] = await Promise.all(
        c.chargeIds.map((chargeId) => read<Charge>("get_charge", { chargeId })),
      );
      if (!a || !b) continue;
      if (mistake.kind === "refund_control") refunds.push({ charge: b, original: a });
      if (mistake.kind === "refund_both") refunds.push({ charge: a, original: b });
    }
    if (refunds.length === 0) continue;
    for (const { charge, original } of refunds) {
      await propose({
        caseKey: c.key,
        tool: "propose_duplicate_refund",
        input: {
          chargeId: charge.id,
          duplicateOfChargeId: original.id,
          rationale: `${charge.id} repeats ${original.id} for invoice ${original.invoice}.`,
        },
        amountMinor: charge.amount,
        currency: charge.currency,
      });
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
    for (const { charge } of refunds) {
      await propose({
        caseKey: c.key,
        tool: "propose_refund_note",
        input: { refundStepId: `refund_${charge.id}`, ticketId },
        amountMinor: charge.amount,
      });
    }
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
