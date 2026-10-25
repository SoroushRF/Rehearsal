# Billing incident scenario

Fictional company and authored demo policy. Not a financial or regulatory requirement.

- `policy.v1.json`: remedy policy (CAD only, refunds of 10000 minor units or more need `finance_lead`).
- `cases/*.bundle.json`: shared replay bundles, generated from `packages/testkit/src/bundles.ts` by `pnpm fixtures:write`. Don't hand-edit them; a test fails if they drift.
  - `happy-path`: two customers, nothing changes.
  - `phantom`: a new matching charge appears after approval. That customer's refund is held and its note skipped.
  - `unknown-outcome`: the refund commits but its response is lost. Recovery must not refund twice.
  - `teammate-conflict`: a later step fails, and a teammate edits the patched priority before compensation runs. Compensation keeps their edit.
- `incident.v1.json`: the seeded INC-BILL-0927 cohort. It has 8 customers charged twice for their September invoice (CAD; two of them at or above the finance threshold), plus three controls: two different invoices, a USD duplicate, and a duplicate from August, outside the window. Each case also gets an open ticket whose `external_id` is the Stripe customer ID.
  - `@rehearsal/testkit`'s `incidentRecords()` builds the inject records from it and from `fixtures/`.
  - `pnpm demo:reset` resets all four worlds, seeds them identically and checks that planning and operational read back the same.
- `fixtures/`: Era inject templates copied from real GET responses (owner: A). See `fixtures/README.md`.
- `expected/`: independent expected results (owner: D). Not created yet.
- Held-out incidents for evaluation, with hidden gold, live in [`evals/held-out`](../../evals/held-out/README.md). Nothing here may read them.

All bundles are `evidence: "fixture"` until they have run against real Era images.
