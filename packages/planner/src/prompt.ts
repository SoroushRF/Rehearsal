import { fingerprint } from "@rehearsal/core";

/**
 * T1.5: the versioned planning prompt and the loop's limits. Both go into the prompt version, so a
 * manifest names exactly the instructions and bounds that produced it. Editing either changes the
 * version; bump PROMPT_ID when the change is meant, so a reviewer can tell versions apart by name.
 */
export const PROMPT_ID = "billing-remedy.v1";

/** The model the planner uses unless PLANNER_MODEL pins another. Never an unpinned alias. */
export const DEFAULT_PLANNER_MODEL = "claude-sonnet-5-5";

export const LOOP_LIMITS = {
  /** Model turns. A turn may hold several tool calls. */
  maxTurns: 40,
  /** Tool calls across the whole run. */
  maxToolCalls: 200,
  /** Output tokens per turn. Non-streaming requests stay well under the SDK's HTTP timeout. */
  maxTokensPerTurn: 16_000,
  /** Agentic multistep tool use: medium is the documented starting point for Sonnet 5.5. */
  effort: "medium",
} as const;

export const SYSTEM_PROMPT = `You are the planning agent of Rehearsal. You investigate a billing incident in a planning copy of the company's Stripe and Zendesk, and propose a remediation plan. A human reviews the exact plan before anything runs, and a deterministic executor (not you) applies it to production later. Nothing you do here changes production.

You can only use the tools provided. Read tools return what the planning world holds and record it as evidence. Propose tools add one step each to the plan; they re-read what they depend on and refuse anything that doesn't hold up. A refusal is an answer, not an obstacle: never try to work around one by picking other IDs.

For each customer in the incident report:
1. List the customer's charges in the incident window. A duplicate is two succeeded, unrefunded charges for the same invoice with the same amount and currency. Keep the earliest paid charge of the invoice as the original and refund the later one with propose_duplicate_refund.
   Only if propose_balance_credit is among your tools: for a small duplicate, credit the customer's invoice balance with it instead of refunding. If it refuses, refund the charge. Never propose both for one duplicate.
2. If no charge pair is a duplicate (different amounts, another currency, outside the window, already refunded), propose nothing for that customer. Say why in your final summary.
3. For each refund you proposed, find the customer's support ticket with list_requester_tickets. Use the ticket whose external_id is the customer's Stripe ID. Then:
   - propose_ticket_priority to "high", unless the ticket is already high or urgent;
   - propose_refund_note on that ticket, so the customer's ticket records the refund;
   - propose_customer_reply on that ticket, so the customer hears the refund went out. If it refuses, leave the reply out.
4. Never propose steps for a customer who isn't in the report, and never propose a ticket step for a customer without a refund.
5. Last, if you proposed any refund, call propose_run_summary once so the team's channel hears what the run did. If it refuses, leave it out.

Rationales are shown to the reviewer verbatim. Keep each to one plain sentence that names the evidence (charge IDs, invoice, amounts in minor units with currency).

When every customer is handled, stop calling tools and reply with a short summary: one line per customer saying what you proposed or why you proposed nothing.`;

/** The prompt, the limits and the default model, as one version string recorded in the manifest. */
export const PROMPT_VERSION = `${PROMPT_ID}+${fingerprint({ SYSTEM_PROMPT, LOOP_LIMITS }).slice(0, 12)}`;

export interface IncidentBrief {
  incident: string;
  summary: string;
  window: { createdGte: string; createdLt: string };
  /** The customers who reported the problem. What happened to each is for the agent to find out. */
  customers: { customerId: string; name: string; requesterId: string }[];
  /** Finance-approved precedents recalled for this org, already checked against the registry. */
  precedents?: {
    id: string;
    version: number;
    statement: string;
    conditions: string[];
    exceptions: string[];
  }[];
}

/** The first user message: the incident report, without anything the agent should discover. */
export function briefMessage(brief: IncidentBrief): string {
  const rows = brief.customers.map(
    (c) => `- ${c.name}: Stripe customer ${c.customerId}, Zendesk requester ${c.requesterId}`,
  );
  return [
    `Incident ${brief.incident}: ${brief.summary}`,
    `Incident window: charges created from ${brief.window.createdGte} up to (not including) ${brief.window.createdLt}.`,
    `Customers who reported it (${brief.customers.length}):`,
    ...rows,
    ...precedentLines(brief.precedents ?? []),
    "Plan the remediation.",
  ].join("\n");
}

/**
 * Precedents are context for the plan, never permission: a tool's refusal still stands. The
 * plan records exactly which versions it was given, so the reviewer sees them too.
 */
function precedentLines(precedents: NonNullable<IncidentBrief["precedents"]>): string[] {
  if (precedents.length === 0) return [];
  return [
    `Finance-approved precedents for this organization (${precedents.length}). Follow them where they apply; they never override a tool's refusal:`,
    ...precedents.flatMap((p) => [
      `- ${p.id} v${p.version}: ${p.statement}`,
      ...p.conditions.map((c) => `  - Applies when: ${c}`),
      ...p.exceptions.map((e) => `  - Except: ${e}`),
    ]),
  ];
}
