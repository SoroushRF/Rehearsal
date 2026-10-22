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

- **2026-10-21, Artin (T3.2).** Branch `t3/T3.2-executor-loop`, stacked on `fix/T3.1-review`. `executeRun` in `packages/core/src/executor.ts`:
  - **Run-level admission** re-checks the stored run, the stored and recomputed hash, and the grant (same plan, revision and hash, not revoked or expired, roles cover every step). It also checks policy and graph. Any failure means nothing is dispatched.
  - **Steps** run in topological order. Each one: guard hook (T4), resolve bindings, prepare, journal, mark `dispatched`, dispatch, then confirm or reject or unknown, then receipt. Dependents of anything not confirmed get `skipped_dependency`, and the run state is honest (`completed`, `partial`, `held` or `failed`).
  - **Operation keys** are per org + plan + action (+ kind, obligation, target): stable across revisions of one plan, unique within it. Prior attempts are looked up by key, so a re-approved identical revision adopts earlier results instead of re-sending, and a changed one is held.
  - **`JournalPort` gained `attemptsForKey` and `settle`** (additive). `settle` writes the transition, bindings and receipt in one transaction.
  - **Testkit additions:** `FakeWorld` (Stripe idempotency on exact bytes, scripted reject and drop-after-commit faults), `MemoryJournal` and `MemoryApplyStore`. The `happy-path` bundle passes on the fake.
  - **Next:** T3.3 real Era write adapters, then wire the executor worker to consume `apply` jobs with a Postgres `ApplyStore`.
  - **Gotchas:**
    - A `dispatched` or `unknown_outcome` attempt is held and never re-sent, until T3.5 adds reconcile.
    - A rejected attempt is never re-sent by a later run; T3.4 adds bounded in-run retries.
    - An unexpected error stops the run (`step.error` event, `RunOutcome.error`); remaining steps get no receipt.
    - The note template formats CAD only, matching policy v1.
    - Guards (`StepGuard`) run only right before a request would be sent, and get `confirmedReceipts` for this hash (earlier runs included) so T4 can build the own-write overlay with `advanceOverlay`.
    - A prepared-but-never-sent attempt from another revision is ignored: it neither blocks nor gets reused.
    - Admission doesn't refuse an *older* revision once a newer one is approved. That belongs to the approval lifecycle (T2).
    - Rejected-but-retryable steps aren't retried yet (T3.4).
    - Confirmed receipts carry a limitation saying the effect came from the write response, not a read-back.
    - Admission is a cross-track-review path.

- **2026-10-22, Artin (T3.1 review fixes).** Branch `fix/T3.1-review`. #36 and #37 merged before their review fixes landed; this carries them, with forward migration `0002`:
  - `step_attempts` unique key is org-scoped.
  - `runs` allows one *active* run per hash (partial index), so a held, partial or failed run can be re-applied. It also records `requested_by`.
  - The apply body is strict, the API survives Postgres being down, and `appendEvent` accepts an empty payload.
- **2026-10-21, Artin (T3.1 part 2).** Branch `t3/T3.1-apply`, stacked on `t3/T3.1-journal` (PR #36). pg-boss 12.37.0 runs in the same Postgres. `requestApply` checks the stored revision, its hash (re-computed from the stored manifest) and a live grant, then creates the run and enqueues the `apply` job in **one transaction**. A unique `(org_id, plan_hash)` index on `runs` makes a repeated apply return the existing run. `POST /api/plans/:id/apply` returns 401, 400, 404, 409, 403 or 202. **Next:** T3.2, the executor worker consumes `apply` jobs, with admission re-checking everything. **Gotchas:** auth is a placeholder `AuthResolver` that refuses everything (`noAuth`) until T2.3 wires Clerk in. Grant roles (finance over the threshold) are checked when T2 issues the grant, not here; T3.2 admission must re-check them.
- **2026-10-21, Artin (T3.1 part 1).** Branch `t3/T3.1-journal`: `runs` table, first Drizzle migration, `PgJournal` (org-scoped, compare-and-set transitions, legal-transition table, write-once bindings), 9 tests passing on real Postgres 17. CI now starts a Postgres service and sets `DB_TESTS=1`. **Next:** T3.1 part 2, pg-boss setup and `POST /api/plans/:id/apply` (touches T2's `apps/api`, keep it minimal). **Gotchas:** `unknown_outcome` can only move to `reconciled`; run the DB tests locally with `docker compose -f infra/compose.yaml up -d postgres` then `DB_TESTS=1 pnpm --filter @rehearsal/db test`.
