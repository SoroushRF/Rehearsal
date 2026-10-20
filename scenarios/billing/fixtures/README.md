# Era inject templates

Verbatim GET responses from a fresh tenant of the planning world: pinned images, seed 42, `day1`, `2026-10-01`, fidelity `high`. Captured 2026-10-19 by `pnpm fixtures:capture`. Don't hand-edit them. Re-capture after changing an image pin; `evals/providers/test/fixtures.test.ts` fails if they drift.

- `stripe.charge.json`: `GET /v1/charges/ch_7wD2ja8lIorW65Uh`. This is a succeeded USD charge for `cus_necGym2uIJ94j40b`, with no refunds and no dispute.
- `zendesk.ticket.json`: `GET /api/v2/tickets/4000000.json`. The response is wrapped in `{"ticket": …}`.

To use one, copy the template, change the identity and the fields you need, and post it to `POST /_admin/tenants/{T}/inject` as `{"charges":[…]}` or `{"tickets":[…]}`:

- **Stripe**: inject does not fill in missing fields, so start from the whole object. Stripe re-derives `refunds.url` from the new id. Everything else is stored and read back as given, so update `customer`, `payment_intent`, `balance_transaction`, `amount_captured` and the like yourself.
- **Zendesk**: inject echoes derived fields as given. When you change `id` or `subject`, also rewrite `url`, `raw_subject` and `description`. Supply an explicit `comments` thread; the first entry rendered is the `description`.

Use inject only for setup and for planting new records. Never use it as a stand-in for a teammate's edit while a plan is applying: inject rebuilds the projection.
