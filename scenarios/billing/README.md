# Billing incident scenario

Fictional company and authored demo policy. Not a financial or regulatory requirement.

- `policy.v1.json`: remedy policy (CAD only, refunds of 10000 minor units or more need `finance_lead`).
- `cases/*.bundle.json`: shared replay bundles, generated from `packages/testkit/src/bundles.ts` by `pnpm fixtures:write`. Don't hand-edit them; a test fails if they drift.
  - `happy-path`: two customers, nothing changes.
  - `phantom`: a new matching charge appears after approval. That customer's refund is held and its note skipped.
  - `unknown-outcome`: the refund commits but its response is lost. Recovery must not refund twice.
  - `teammate-conflict`: a teammate edits priority and a later step fails. Compensation keeps their edit.
- `fixtures/`: Era inject templates copied from real GET responses (owner: A). See `fixtures/README.md`.
- `expected/`: independent expected results (owner: D). Not created yet.

All bundles are `evidence: "fixture"` until they have run against real Era images.
