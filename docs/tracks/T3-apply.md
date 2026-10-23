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

| ID | Task | Milestone | Done when | Issue | Blocked by |
|---|---|---|---|---|---|
| T3.1 | Drizzle migrations; Postgres `JournalPort` with compare-and-set attempt transitions; pg-boss setup; `POST /api/plans/:id/apply` enqueues a job | M1 | Journal tests against a real Postgres | #18 | — |
| T3.2 | Executor loop on a FakeProvider: admission (stored manifest + hash + grant), topological order per case, prepare → journal → dispatch → confirm → receipt, result bindings | M1 | `happy-path` bundle passes on the fake provider | #19 | T3.1 |
| T3.3 | Write adapters: Stripe refund (form-encoded, exact stored bytes, idempotency key = operation key), Zendesk patch (`safe_update` + `updated_stamp`), private note (`public:false`, operation marker) | M2 | Real Era refund, patch and note, each with a receipt | #20 | T3.2, T1.9 |
| T3.4 | Retries: bounded backoff, Retry-After on 429 and transient errors; validation and permission errors are rejected, not retried | M2 | Era fault injection → retried, one effect | #21 | T3.3 |
| T3.5 | Unknown outcome: a test transport that forwards then drops the response, crash and restart, reconcile through reads | M3 | `unknown-outcome` bundle passes on Era | #22 | T3.4 |
| T3.6 | ID divergence test, partial-completion run state, cancellation before the next admitted action | M3 | Tests green; UI shows partial honestly | #23 | T3.3 |
| T3.7 | Bounded concurrency across independent cases. Only after everything above is green. | M4 | Optional | #24 | T3.5, T3.6 |

## Decisions

_(add dated entries)_

## Handoff log

_(newest first: date, who, state, open PRs or branches, next step, gotchas)_

- **2026-10-22, Artin (T3.6).** Branch `t3/T3.6-cancel-reaper`.
  - **Cancellation:**
    - `requestCancel` and `POST /api/runs/:id/cancel` move an `approved` or `applying` run to `cancelled`.
    - The executor checks `ApplyStore.runCancelled` before admission, before every step and before every send, retries included. It stops there and the run ends `cancelled`.
    - Receipts keep every effect that did happen; nothing is rolled back. An earlier send whose outcome is unknown stays `unknown_outcome` and is never re-sent.
    - **A cancelled run still owes a read-only reconcile.** If a send was left in flight (the worker died after dispatch), the job's next delivery, or the reaper, which also picks up cancelled runs with in-flight attempts, runs a reconcile-only pass. It resolves those attempts by reading and writes their receipts. It never sends, and the run stays `cancelled`. A read that finds nothing never closes the attempt, because no replay will follow; it holds once and isn't re-held by later passes. The reaper re-enqueues any stuck run (approved, applying, or cancelled with a send in flight) at most `MAX_REAPS` (12) times, recording each as a `run.reaped` event. After that it writes one `run.needs_operator` event and stops: an explicit hand-off, never an endless loop.
    - The 202 means cancel *requested*: a send already on the wire, or one in the brief window after the last check, still lands and gets its receipt.
  - **Lock before admission:** the plan lock is taken before admission. A stale or overlapping delivery gets `PLAN_LOCKED` (so it retries and the run stays `applying`) instead of a refusal like "grant expired" that would mark a running run `failed`.
  - **Reaper:** `reapStuckRuns` re-enqueues runs left `approved` or `applying` with no live pg-boss job (`created`, `retry` or `active`) for 10 minutes. The worker sweeps every 60 s, and a transaction advisory lock lets only one reaper act at a time.
  - **ID divergence:** `id-divergence.test.ts` on Era rehearses the refund in the planning world, then advances the operational world's ID counter. The note carries the operational refund ID, never the rehearsed one.
  - **Next:** T3.7 (bounded concurrency).
  - **Gotchas:**
    - A cancel can't interrupt a send already on the wire.
    - The cancel route uses the same placeholder auth as apply, until T2.3.
    - `retries.test.ts` "throttled refund" has a known, rare flake on the shared Era container (also noted in #68).

- **2026-10-22, Artin (worker wiring).** Branch `t3/worker-wiring`. The executor worker now consumes `apply` jobs:
  - **`handleApplyJob`** (`apps/executor-worker/src/worker.ts`):
    - Re-validates the payload.
    - Sets the run to `applying`.
    - Runs `executeRun` with a `PgJournal`, a `PgApplyStore`, the real T1.3 readers with the T3 writers, `createReadGuard`, and **wall-clock time**.
    - Writes the outcome to `runs.state`. On a lock miss (`PLAN_LOCKED`) it puts the run back to `approved` and throws `RetryLater`, so pg-boss retries.
  - **`PgApplyStore`** (`packages/db/src/apply-store.ts`):
    - Org-scoped loads of runs, plans and grants.
    - **`lockPlan`** is a session advisory lock on `hashtextextended('rehearsal:apply:org:plan')`, held on its own pooled connection for the whole run. If the worker dies, Postgres drops it.
  - **The `apply` queue** retries generously (50 retries with backoff, capped at 300 s; a job expires after 30 min). That's safe because runs resume from the journal.
  - **Run state is compare-and-set.** The worker first checks the job against the stored run, then claims the run only from `approved` or `applying`. A stale or duplicate job is skipped, so it can't revive a finished or cancelled run. On the last retry, a run that still couldn't finish is marked `failed`, so a new apply can resume it. A malformed payload is skipped, not retried. A lock miss leaves the run `applying`, because the holder may be an overlapping delivery of the same job. The delivery that ran writes its outcome from `applying` or `failed`, so its real result wins over a last-try `failed`. The job's own stored `retryLimit` is used.
  - **`pnpm smoke:apply`** runs end to end with real processes: start the API (the minter) and the worker with the same `ERA_TENANT` and `DATABASE_URL`, then run the script.
  - **Gotchas:**
    - If only the lock's connection drops mid-run, the lock is gone while the run continues. It's logged; a second worker could start another revision of the plan in that window.
    - The shared test database collects unconsumed `apply` jobs from the API tests. Point the worker at a fresh database for smoke runs.
    - The API and the workers need the T1.9 secrets in `.env`.

- **2026-10-22, Artin (T3.5).** Branch `t3/T3.5-reconcile`. A step with a `dispatched` or `unknown_outcome` attempt now calls `provider.reconcile` and no longer just holds:
  - **Applied:** confirmed, with the read's results as bindings. The attempts move to `reconciled` in one atomic settle.
  - **Not applied, and older than `reconcileAfterMs` (60 s):** the attempts become `rejected` with no status, then the step is sent fresh.
  - **Otherwise:** held.
  - **Reads:** `stripeWriter` and `zendeskWriter` implement `reconcile` with real reads, as does FakeWorld.
  - **Atomic replay:** `SettleStep.transitions` makes the in-run replay's reconciled marks atomic.
  - **Tests:** the `unknown-outcome` bundle passes with a restart. The live Era test (`reconcile.test.ts`) loses every write's response across three restarts, and each write is applied once.
  - **Next:** worker wiring (pg-boss consumer, Postgres `ApplyStore` with `lockPlan`, `createReadGuard`), then T3.6.
  - **Gotchas:**
    - If another revision's run reconciled this hash's attempt, a re-run of this hash reads the effect back to record its own receipt and bindings. It never re-sends.
    - The reconcile window uses the executor's clock against `dispatchedAt`.

- **2026-10-22, Artin (T3.4).** Branch `t3/T3.4-retries`. The executor retries within a run following [decision 0003](../decisions/0003-idempotent-resend-and-retries.md):
  - **429:** bounded backoff that honors Retry-After, re-sending identical bytes as a new attempt row each time. A later run may send it again.
  - **Unknown outcomes** (5xx, timeout, lost response): re-sent only when `ProviderPort.idempotentResend` says so, which today means Stripe refunds only. The replay marks earlier unknown attempts `reconciled`.
  - **Other 4xx:** never retried.
  - **Settings:** `ExecutorDeps.retry` and `ExecutorDeps.sleep` are injectable.
  - **Live tests** (`evals/providers/test/retries.test.ts`): Era `fail_next` 429 → retried after the real Retry-After → one refund. Era `error_rate` 500 → re-sent under the same key → one refund.
  - **Next:** T3.5, reconcile through reads for the restart case and for Zendesk.

- **2026-10-22, Artin (T3.3).** Branch `t3/T3.3-write-adapters`. `packages/providers/src/write.ts` adds `stripeWriter` and `zendeskWriter`, which are the write half of `ProviderPort`. `withWriter(read, write)` joins them with T1's read half, and `writeOnly` refuses reads until T1.3 lands.
  - **Stripe refund:** form-encoded in a fixed order, with idempotency key = operation key, which is also stored as `metadata[rehearsal_op]`.
  - **Zendesk patch:** `safe_update` plus an `updated_stamp` read just before. The stamp comes from the new optional `ProviderPort.preconditions` and is journaled inside the request bytes; a failed read holds the step.
    - Our own writes move the stamp, so content is compared using the stamp the journaled attempt carried, recovered with `ProviderPort.preconditionsOf`, never a fresh read. That way an identical revision adopts the patch and a 409 re-run reports `rejected`.
    - A never-sent prepared attempt whose only difference is a moved stamp is superseded by a new attempt.
  - **Zendesk note:** always sent with explicit `public:false` and the operation marker.
  - **Response classification:** 2xx is confirmed. 429 is a retryable rejection (with Retry-After). Other 4xx are non-retryable rejections. 5xx, timeouts and transport errors are `unknown`, never rejected.
  - **Receipts:** `observedEffect` now carries what the provider says it holds (ticket priority and status, refund fields) for T4's overlay.
  - **Evidence:** `era_integration`. The executor applied all three steps to a real operational world (`evals/providers/test/write-adapters.test.ts`).
  - **Next:** T3.4 retries, T3.5 reconcile (writers return `indeterminate` today), worker wiring with a Postgres `ApplyStore` and `lockPlan`.

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
    - `ApplyStore.lockPlan` serializes all revisions of one plan; a run that can't get the lock returns `held` with a refusal and should be retried. The Postgres store (with worker wiring) must implement it with a session advisory lock on (org, plan).
    - Rejected-but-retryable steps aren't retried yet (T3.4).
    - Confirmed receipts carry a limitation saying the effect came from the write response, not a read-back.
    - Admission is a cross-track-review path.

- **2026-10-22, Artin (T3.1 review fixes).** Branch `fix/T3.1-review`. #36 and #37 merged before their review fixes landed; this carries them, with forward migration `0002`:
  - `step_attempts` unique key is org-scoped.
  - `runs` allows one *active* run per hash (partial index), so a held, partial or failed run can be re-applied. It also records `requested_by`.
  - The apply body is strict, the API survives Postgres being down, and `appendEvent` accepts an empty payload.
- **2026-10-21, Artin (T3.1 part 2).** Branch `t3/T3.1-apply`, stacked on `t3/T3.1-journal` (PR #36). pg-boss 12.37.0 runs in the same Postgres. `requestApply` checks the stored revision, its hash (re-computed from the stored manifest) and a live grant, then creates the run and enqueues the `apply` job in **one transaction**. A unique `(org_id, plan_hash)` index on `runs` makes a repeated apply return the existing run. `POST /api/plans/:id/apply` returns 401, 400, 404, 409, 403 or 202. **Next:** T3.2, the executor worker consumes `apply` jobs, with admission re-checking everything. **Gotchas:** auth is a placeholder `AuthResolver` that refuses everything (`noAuth`) until T2.3 wires Clerk in. Grant roles (finance over the threshold) are checked when T2 issues the grant, not here; T3.2 admission must re-check them.
- **2026-10-21, Artin (T3.1 part 1).** Branch `t3/T3.1-journal`: `runs` table, first Drizzle migration, `PgJournal` (org-scoped, compare-and-set transitions, legal-transition table, write-once bindings), 9 tests passing on real Postgres 17. CI now starts a Postgres service and sets `DB_TESTS=1`. **Next:** T3.1 part 2, pg-boss setup and `POST /api/plans/:id/apply` (touches T2's `apps/api`, keep it minimal). **Gotchas:** `unknown_outcome` can only move to `reconciled`; run the DB tests locally with `docker compose -f infra/compose.yaml up -d postgres` then `DB_TESTS=1 pnpm --filter @rehearsal/db test`.
