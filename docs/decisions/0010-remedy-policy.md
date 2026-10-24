# 0010: Policy v2 decides refund or invoice credit (T2.18)

**Status:** proposed 2026-10-24 (Parsa, T2). The amounts and the rule are authored demo policy; please object in chat or on the PR if finance would draw the line elsewhere.

## Context

[0009](0009-reopen-full-scope.md) brings back the invoice-balance credit as an alternative remedy to a refund (T1.14). The contracts op `stripe.customer.balanceCredit` exists (T1.19) but is not in `Action`, so no plan can carry one. T1.14 adds it only once the policy (this task), the write adapter (T3.12) and the one-remedy guard (T4.10) handle it. Policy v1 knows only refunds, and an approval cites the policy it was checked against (`manifest.policies`).

## Decision

1. **A new version, never an edit.** `scenarios/billing/policy.v2.json` adds `creditMaxMinor` (10000, CAD). v1 stays loaded, so plans and approvals made against it stay valid. The API and the executor load both.
2. **Which remedy an obligation gets.** Money goes back by refund. A credit stays on the customer's account, so it is allowed only below `creditMaxMinor`; at or above it the obligation must be refunded (`R4.credit_over_limit`). v1 has no credit at all (`R4.remedy_not_allowed`).
3. **One remedy per obligation.** `R2.single_remedy` now counts a refund and a credit together.
4. **A completed remedy blocks a second one.** `evaluateBillingPolicy` takes an optional `completedRemedies` (obligation to the step that settled it) and holds any new remedy for one of them (`R5.remedy_already_completed`). Supplying that map from stored receipts, and re-checking the provider at apply time, is T4.10's guard; policy only judges what it is told.
5. **Currency and the finance threshold apply to a credit exactly as to a refund** (`R1`, `R3`).
6. **The review UI shows the remedy** as a distinct step ("Credit the customer's next invoice" or "Refund the customer") with its amount; the planner (T1.14) is what chooses between them within these rules.

## Consequences

- With both limits at 10000, a credit never reaches the finance threshold today; `R3` is kept so a later policy can raise `creditMaxMinor` without a gap.
- Nothing is wired to produce a credit until T1.14 adds the op to `Action`; until then the new rules are exercised only by tests.
- Admission and approval re-evaluate under whichever policy a plan cites, so a plan that cites v2 and carries a refund or a small credit is accepted, and one carrying a large credit is held at both places.
- T4.10 supplies item 4 from the journal: every remedy attempt for the obligation in any plan or revision of the org. One limit remains. Two plans applying at once can both read "no remedy" before either sends, because nothing reserves the obligation. Inside one plan, R2 already rules this out. Across plans it needs a per-obligation lock or reservation, which isn't built.
