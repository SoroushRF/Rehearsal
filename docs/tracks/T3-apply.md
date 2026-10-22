# T3 Apply: exactly the approved plan, with receipts

**Owner:** see the [roster](../../AGENTS.md#roster).

**Demo moment:**
1. The executor applies the approved plan step by step, with no model involved.
2. Injected 429 errors are retried with exactly the same request.
3. A refund whose response was lost is reconciled, not refunded twice.
4. Every step ends in an honest receipt.

**Owns:**
- `packages/db`: schema, migrations, journal
- `apps/executor-worker`
- The executor engine in `packages/core`
- `packages/providers` write side (prepare, dispatch, reconcile)
- The job queue (pg-boss)

**Provides to others:**
- An admission hook that T4's guards plug into.
- Receipts and events for T2's views.

## Acceptance

These must pass on Era, not just on fixtures:
- **Happy path:** the `happy-path` bundle passes end to end.
- **Unknown outcome:** the `unknown-outcome` bundle passes. That means exactly one refund after a lost response and a process restart.
- **ID mapping:** fork and production IDs are forced to differ, and the note still references the refund ID returned in production.
- **Refusals:** no approval, a changed hash, or a revoked grant means nothing is dispatched.
- **Partial completion:** shown as partial, never as success.

## Tasks

| ID | Task | Milestone | Done when | Issue |
|---|---|---|---|---|
| T3.1 | Drizzle migrations; Postgres `JournalPort` with compare-and-set attempt transitions; pg-boss setup; `POST /api/plans/:id/apply` enqueues a job | M1 | Journal tests against a real Postgres | #18 |
| T3.2 | Executor loop on a FakeProvider: admission (stored manifest + hash + grant), topological order per case, prepare → journal → dispatch → confirm → receipt, result bindings | M1 | `happy-path` bundle passes on the fake provider | #19 |
| T3.3 | Write adapters: Stripe refund (form-encoded, exact stored bytes, idempotency key = operation key), Zendesk patch (`safe_update` + `updated_stamp`), private note (`public:false`, operation marker) | M2 | Real Era refund, patch and note, each with a receipt | #20 |
| T3.4 | Retries: bounded backoff, Retry-After on 429 and transient errors; validation and permission errors are rejected, not retried | M2 | Era fault injection → retried, one effect | #21 |
| T3.5 | Unknown outcome: a test transport that forwards then drops the response, crash and restart, reconcile through reads | M3 | `unknown-outcome` bundle passes on Era | #22 |
| T3.6 | ID divergence test, partial-completion run state, cancellation before the next admitted action | M3 | Tests green; UI shows partial honestly | #23 |
| T3.7 | Bounded concurrency across independent cases. Only after everything above is green. | M4 | Optional | #24 |

## Decisions

_(add dated entries)_

## Handoff log

_(newest first: date, who, state, open PRs or branches, next step, gotchas)_

- **2026-10-21, Artin (T3.1 part 1).** Branch `t3/T3.1-journal`: `runs` table, first Drizzle migration, `PgJournal` (org-scoped, compare-and-set transitions, legal-transition table, write-once bindings), 9 tests passing on real Postgres 17. CI now starts a Postgres service and sets `DB_TESTS=1`. **Next:** T3.1 part 2, pg-boss setup and `POST /api/plans/:id/apply` (touches T2's `apps/api`, keep it minimal). **Gotchas:** `unknown_outcome` can only move to `reconciled`; run the DB tests locally with `docker compose -f infra/compose.yaml up -d postgres` then `DB_TESTS=1 pnpm --filter @rehearsal/db test`.
