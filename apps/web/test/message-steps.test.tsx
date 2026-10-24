import {
  type Receipt,
  SlackMessagePostSummary,
  StripeCustomerBalanceCredit,
  ZendeskTicketAppendPublicReply,
} from "@rehearsal/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionRow } from "../src/components/ActionRow";
import { PlanReview } from "../src/components/PlanReview";
import { fixtureBundles } from "../src/fixtures";
import { droppedBy, groupByCase, type ReviewAction, type ReviewManifest } from "../src/plan";
import { explainReceipt } from "../src/runs";

const base = {
  caseId: "case_001",
  obligationId: "obl_001",
  requiredRole: "support_lead",
  evidence: [],
  queryEvidence: [],
  rationale: "Tell them.",
};

const reply = ZendeskTicketAppendPublicReply.parse({
  ...base,
  id: "reply_001",
  dependsOn: ["refund_001"],
  kind: "zendesk.ticket.appendPublicReply",
  compensation: "irreversible",
  protection: "no_atomic_guard",
  args: {
    ticketId: "9001",
    public: true,
    template: { id: "duplicate-refunded", version: 1 },
    values: { amount: "$42.10 CAD" },
    body: "Hi,\nWe refunded $42.10 CAD for the duplicate charge <b>today</b>.",
  },
});

const summary = SlackMessagePostSummary.parse({
  ...base,
  id: "summary_001",
  caseId: "run",
  obligationId: "run_summary",
  dependsOn: ["refund_001", "refund_002"],
  kind: "slack.message.postSummary",
  compensation: "irreversible",
  protection: "no_atomic_guard",
  args: {
    channelId: "C0BILLINGOPS",
    template: { id: "run-summary", version: 1 },
    bindings: {
      incident: "inc_dup_2026_10",
      refunded: {
        $count: "outcomes",
        stepIds: ["refund_001", "refund_002"],
        outcomes: ["confirmed"],
      },
      held: {
        $count: "outcomes",
        stepIds: ["refund_001", "refund_002"],
        outcomes: ["held", "unknown_outcome"],
      },
    },
  },
});

const row = (action: ReviewAction, dependsOnLabels: string[] = []) =>
  renderToStaticMarkup(
    <ul>
      <ActionRow
        action={action}
        selected={false}
        onShowEvidence={() => {}}
        dependsOnLabels={dependsOnLabels}
      />
    </ul>,
  );
const words = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

describe("public reply row (T2.16)", () => {
  const html = row(reply, ["refund_001"]);

  it("shows the exact text the customer receives, not a description of it", () => {
    expect(html).toContain('data-testid="public-reply-text"');
    expect(html).toContain("We refunded $42.10 CAD for the duplicate charge");
    expect(words(html)).toContain("The customer will receive exactly this text");
  });

  it("renders the text as text: markup in it is escaped and line breaks are kept", () => {
    expect(html).not.toContain("<b>today</b>");
    expect(html).toContain("&lt;b&gt;today&lt;/b&gt;");
    expect(html).toContain("whitespace-pre-wrap");
  });

  it("says it can't be taken back and what depends on what", () => {
    const text = words(html);
    expect(text).toContain("Reply to the customer on ticket #9001");
    expect(text).toContain("Irreversible");
    expect(text).toContain("After refund_001");
    expect(text).toContain("can't be taken back");
  });
});

describe("excluding a step", () => {
  const refund = { id: "refund_001", dependsOn: [] as string[] } as ReviewAction;
  const other = { id: "refund_002", dependsOn: [] as string[] } as ReviewAction;

  it("drops the reply that follows it, and keeps the summary while it still counts a step", () => {
    const steps = [refund, other, reply, summary];
    expect([...droppedBy(steps, ["refund_001"])].sort()).toEqual(["refund_001", "reply_001"]);
  });

  it("drops the summary once every step it counts is gone", () => {
    const steps = [refund, other, reply, summary];
    expect([...droppedBy(steps, ["refund_001", "refund_002"])].sort()).toEqual([
      "refund_001",
      "refund_002",
      "reply_001",
      "summary_001",
    ]);
  });

  it("drops the summary alone when it is unchecked", () => {
    const steps = [refund, other, reply, summary];
    expect([...droppedBy(steps, ["summary_001"])]).toEqual(["summary_001"]);
  });
});

describe("Slack summary row (T2.15)", () => {
  const html = row(summary, ["refund_001", "refund_002"]);
  const text = words(html);

  it("names the channel, the template and the steps it waits for", () => {
    expect(text).toContain("Post a summary to Slack channel C0BILLINGOPS");
    expect(text).toContain("run-summary");
    expect(text).toContain("After refund_001, refund_002");
    expect(text).toContain("Irreversible");
  });

  it("spells out each filled-in value, counts included, and promises no free text", () => {
    expect(text).toContain("incident inc_dup_2026_10");
    expect(text).toContain("refunded the number of refund_001, refund_002 that end up done");
    expect(text).toContain(
      "held the number of refund_001, refund_002 that end up held or outcome unknown",
    );
    expect(text).toContain("never free text");
  });

  it("doesn't pretend to know the final text before the run", () => {
    expect(text).toContain("when the run ends");
  });
});

describe("receipts for sends other people read", () => {
  const unknown = {
    outcome: "unknown_outcome",
    holdReason: null,
    providerRef: null,
  } as unknown as Receipt;

  it("an unresolved reply or post says it will be looked up, never sent again", () => {
    expect(explainReceipt(unknown, "zendesk.ticket.appendPublicReply")).toContain(
      "never sent a second time blindly",
    );
    expect(explainReceipt(unknown, "slack.message.postSummary")).toContain(
      "never posted a second time blindly",
    );
  });

  it("keeps the generic wording for other steps", () => {
    expect(explainReceipt(unknown, "stripe.refund.create")).toContain("never re-sent blindly");
    expect(explainReceipt(unknown)).toContain("never re-sent blindly");
  });
});

describe("invoice credit (T2.18)", () => {
  const manifest = fixtureBundles[0]?.bundle.manifest ?? expect.unreachable();
  const credit = StripeCustomerBalanceCredit.parse({
    ...base,
    id: "credit_001",
    caseId: "case_001",
    obligationId: "obl_credit",
    dependsOn: [],
    kind: "stripe.customer.balanceCredit",
    compensation: "compensable_by_new_action",
    protection: "native_guard_with_documented_limits",
    args: {
      customerId: "cus_fixture_001",
      chargeId: "ch_fixture_001",
      amount: { amountMinor: 4210, currency: "cad" },
    },
  });
  // Swap case_001's refund for the credit: one remedy per obligation.
  const withCredit: ReviewManifest = {
    ...manifest,
    actions: [
      credit,
      ...manifest.actions.filter(
        (a) => a.caseId !== "case_001" || a.kind !== "stripe.refund.create",
      ),
    ],
  };

  it("says in words that it is a credit, not money back", () => {
    const text = words(row(credit));
    expect(text).toContain("Credit the customer's next invoice");
    expect(text).toContain("$42.10 CAD");
    expect(text).toContain("not paid back to the card");
  });

  it("is counted apart from refunds, per customer and in total", () => {
    const [first] = groupByCase(withCredit);
    expect(first?.credits).toEqual([{ amountMinor: 4210, currency: "cad" }]);
    expect(first?.refunds).toEqual([]);
    const text = words(
      renderToStaticMarkup(
        <PlanReview manifest={withCredit} planHash={"a".repeat(64)} evidence="fixture" />,
      ),
    );
    expect(text).toContain("as invoice credit");
    expect(text).toContain("$42.10 CAD credited to next invoices");
    // The other customer's refund is still a refund.
    expect(text).toContain("$125.00 CAD");
    expect(text).toContain("to refund");
  });
});
