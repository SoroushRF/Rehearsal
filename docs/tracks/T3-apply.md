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
| T3.7 | Bounded concurrency across independent cases. Only after everything above is green. | M4 | `caseConcurrency` groups and live Era test | #24 | T3.5, T3.6 |
| T3.8 | _Full scope:_ read back each write before confirming its receipt | full scope | Confirmed receipts carry the read effect; match, mismatch and read-failure tests; reviewer from another track. **Done** | #134 | — |
| T3.10 | _Full scope:_ Slack write adapter; a lost post is resolved by reading the channel, never re-sent | full scope | Journal-before-dispatch plus reconciliation tests on the Era Slack worlds. **Done (adapter):** the executor runs it once T1.7 adds the op | #149 | T1.17 |
| T3.11 | _Full scope:_ Zendesk public reply write adapter; reconcile by reading the ticket's comments | full scope | Unknown outcome resolved through reads on Era; no blind re-send. **Done (adapter):** the executor runs it once T1.13 adds the op | #150 | T1.18 |
| T3.12 | _Full scope:_ Stripe balance credit write adapter with idempotency, read-back and reconciliation | full scope | Lost-response test on Era. **Done (adapter):** the executor runs it once T1.14 adds the op | #151 | T1.19 |

### Beyond and benchmark backlog (Oct 24)

See [beyond.md](../beyond.md) for scope, parallel work, external gates and the release cut line. Blockers are completion prerequisites; fixture/contract work may start earlier. Killer rows are optional.

| ID | Task | Milestone | Done when | Issue | Blocked by |
|---|---|---|---|---|---|
| T3.13 | _Beyond:_ Separate rehearsal persistence and durable jobs | M5 | Separate immutable records and transactional enqueue survive duplicates/restarts. **Done** | [#164](https://github.com/SoroushRF/Rehearsal/issues/164) | [T1.21](https://github.com/SoroushRF/Rehearsal/issues/163) |
| T3.14 | _Beyond:_ Share deterministic execution mechanics while preserving admission boundaries | M5 | Shared mechanics preserve operational refusal and recovery invariants | [#165](https://github.com/SoroushRF/Rehearsal/issues/165) | [T1.20](https://github.com/SoroushRF/Rehearsal/issues/162), [T1.21](https://github.com/SoroushRF/Rehearsal/issues/163), [T3.8](https://github.com/SoroushRF/Rehearsal/issues/134), [T1.7](https://github.com/SoroushRF/Rehearsal/issues/8), [T1.13](https://github.com/SoroushRF/Rehearsal/issues/136), [T1.14](https://github.com/SoroushRF/Rehearsal/issues/137), [T2.13](https://github.com/SoroushRF/Rehearsal/issues/135) |
| T3.15 | _Beyond:_ Execute a stored plan against disposable worlds | M5 | Exact stored plan runs model-free only in matching disposable worlds | [#168](https://github.com/SoroushRF/Rehearsal/issues/168) | [T3.13](https://github.com/SoroushRF/Rehearsal/issues/164), [T3.14](https://github.com/SoroushRF/Rehearsal/issues/165), [T1.22](https://github.com/SoroushRF/Rehearsal/issues/166), [T1.23](https://github.com/SoroushRF/Rehearsal/issues/167) |
| T3.16 | _Beyond:_ Rehearsal worker: restart, cancellation, and cleanup | M5 | Restart/cancel/cleanup preserve unknown outcomes and run isolation | [#170](https://github.com/SoroushRF/Rehearsal/issues/170) | [T3.15](https://github.com/SoroushRF/Rehearsal/issues/168), [T4.11](https://github.com/SoroushRF/Rehearsal/issues/169) |
| T3.17 | _Stretch:_ _Killer:_ Native Stripe sandbox refund writer | M5 | Test-only native refund dispatch/read-back/reconciliation preserves target binding | [#184](https://github.com/SoroushRF/Rehearsal/issues/184) | [T1.24](https://github.com/SoroushRF/Rehearsal/issues/178), [T3.8](https://github.com/SoroushRF/Rehearsal/issues/134) |
| T3.18 | _Stretch:_ _Killer:_ Native Stripe executor recovery gate | M5 | Native sandbox approved-refund/lost-response/restart produces one observed effect | [#185](https://github.com/SoroushRF/Rehearsal/issues/185) | [T3.17](https://github.com/SoroushRF/Rehearsal/issues/184), [T3.5](https://github.com/SoroushRF/Rehearsal/issues/22) |

## Decisions

_(add dated entries)_

## Handoff log

- **2026-10-24 (Codex, backlog planning):** Filed 6 owned M5 issues (T3.13 #164, T3.14 #165, T3.15 #168, T3.16 #170, T3.17 #184, T3.18 #185) with scope/track labels, acceptance criteria and linked blockers. Added the cross-track dependency map in [beyond.md](../beyond.md); native GitHub dependencies mirror these rows. No feature implementation or live validation is claimed. Next: finish the full prerequisites, then follow the graph; optional killer work stays off the main release path.

_(newest first: date, who, state, open PRs or branches, next step, gotchas)_

- **2026-10-25, Artin (T3.13).** Branch `t3/T3.13-rehearsal-store`. Execution rehearsal storage (decision 0013) in `packages/db/src/rehearsals.ts` and migration `0006`: `rehearsals` (bound to the stored plan; snapshot digest and policy taken from the stored manifest, never the caller), append-only `rehearsal_events` (state = last event), `rehearsal_attempts` and `rehearsal_bindings` (the rehearsal's own journal; a CHECK forces every key to start `rh_<id>_`), `rehearsal_step_results` and one immutable `rehearsal_reports` row per rehearsal, all org-scoped. `requestRehearsal` writes the row, its `queued` event and the `rehearsal` queue job in one transaction, idempotent per org and key (a concurrent repeat loses the unique index and returns the winner; another request under the key is `idempotency_conflict`). `transitionRehearsal` locks the row, so one delivery claims `queued → provisioning`; terminal states are final; teardown is recorded once. **Next (T3.14):** a `JournalPort` over the rehearsal tables and `admitRehearsal`. Step results are one per step (unique index), only for a step of the stored plan and only while `running`/`verifying`; an identical repeat is a no-op, a different one is refused. A plan with more than one policy is `unsupported` (a report binds one). **Gotchas:** nothing operational reads these tables; keep it that way. There is no lease column: T3.16's sweeper treats a non-terminal rehearsal whose last event is older than its lease as expired and fails it (never resumes it, decision 0013 §5). No FKs or DB-level append-only guard, like the other tables; integrity is in the store functions.
- **2026-10-24, Artin (credit charge tag).** Branch `t3/credit-charge-tag`. Review of #199 (T4.10): our balance credits didn't name the charge they remedy, so the one-remedy guard could only fall back to matching amounts. `stripeCreditWriter.prepare` now sends `metadata[charge]=<chargeId>` (the key T4.10 reads; fixed order: amount, currency, charge, op key), and reconcile confirms only a credit that names the sent charge (`creditEffectMatches` checks `credit.charge`). **Gotcha (T1.14):** once credits are journaled the request bytes are frozen; a later change to the field set needs a versioned prepare or a reconcile that accepts the old shape.
- **2026-10-24, Artin (T3.10).** Branch `t3/T3.10-slack-writer`. `slackWriter` in `packages/providers/src/write.ts`: `prepare` renders the approved summary template (`run-summary@1` in `packages/core/src/templates.ts`, `summaryTextFor`) from literals and outcome counts the executor resolves under `summaryCountKey(name)`, plus the operation marker; `dispatch` posts with `chat.postMessage` (HTTP 200 `ok:false` → definite refusal, `ratelimited` → retryable 429, 2xx without `ok`/`ts` → unknown); `reconcile` pages `conversations.history` for the marker (no `oldest` window: Era's message clock is simulated). No idempotent re-send: Slack doesn't dedupe, proven on Era. `resolveWorld` now resolves `slack` (`ERA_SLACK_*_URL`). **Next (T1.7):** add the op to `Action`, have the executor compute each outcome count from settled receipts into `summaryCountKey`, and map `slack` in `resultsOf`/providers. **Gotchas:** the Era suite needs `pnpm infra:up:full` and `ERA_CONFORMANCE=1 ERA_SLACK=1`.
- **2026-10-24, Artin (T3.8).** Branch `t3/T3.8-read-back`. After a confirmed write, `step()` reads the effect back through the provider's `reconcile` before the receipt is final: the refund by its operation key (and it must match the approved amount, charge and the response's id), the note by its marker, the patch's fields. **Read:** `confirmed`, the read values merged into `observedEffect`, limitation "read back from the provider after the write". **Contradicted** (the read doesn't find it, or the refund doesn't match): `held` `unresolved_outcome` on the confirmed attempt, nothing bound, so dependents wait; a later run's read-back path re-reads it before it counts. **Inconclusive** (the read failed, or someone else wrote the field since): `confirmed` from the write response, with "read-back inconclusive: …". The web says so for that case. Saved replays rebuilt. A re-approved identical revision never adopts a contradicted write blindly: with no confirmed receipt under the earlier hash it reads the attempt back (confirm and bind only on a matching read). Era's refund reader flags a found-but-contradicting refund (`contradicts: true` on an indeterminate result), which the read-back holds on. **Gotchas:** recovery from a contradicted write needs another run to be started (the attempt is confirmed, so nothing in flight makes the worker or reaper retry it); undo writes still confirm from their response (compensation checks the restored values there); the new ops (T3.10–T3.12) get read-back through their own `reconcile`.
- **2026-10-24, Artin (T3.12).** Branch `t3/T3.12-balance-credit`. `stripeCreditWriter` in `packages/providers/src/write.ts`: `preconditions` reads the customer and refuses a credit in another currency (Era accepts any; Stripe doesn't), a customer with no currency yet takes the credit's; `prepare` posts a negative balance transaction (`amount=-N&currency&metadata[rehearsal_op]`) with the operation key as idempotency key; `idempotentResend` is true (T1.19: same key and bytes replay, other bytes 400); `reconcile` pages the customer's balance transactions for the key and confirms only the exact credit (`creditEffectMatches` in `packages/core/src/effects.ts`: adjustment, customer, -amount, currency, against the sent bytes). **Next (T1.14):** add the op to `Action`, route it here, and use `creditEffectMatches` wherever a refund uses `refundEffectMatches` (T3.8 read-back, reconcile, the readback paths). T4.10 guards one remedy per obligation. **T1.14 traps:** `StripeCreditWriter.prepare(action, key)` doesn't take `ProviderPort.prepare`'s `(action, bindings, key, pre)`; it shares `vendor: "stripe"` with `stripeWriter`, so fold both into one writer that dispatches by `kind` (its `preconditions` must return `{}` for refunds); and cover the refund-specific executor spots: `resultsOf` (the confirmed-response check), the adopt-earlier-results path (hard-codes `refund.id` and a `refund` providerRef), and `targetOf`/`operationKey` (a customer target for credits).
- **2026-10-24, Artin (T3.11).** Branch `t3/T3.11-public-reply`. `zendeskReplyWriter` in `packages/providers/src/write.ts`: `prepare` re-renders the reply from its template and values (`refund-issued@1`, `replyBodyFor` in `packages/core/src/templates.ts`) and refuses a body that doesn't match byte for byte or carries a marker, then sends body + marker as an explicit `public: true` comment; `reconcile` finds the comment by marker across every page (`findMarkedComment`, now shared with the private note) and confirms only if it is exactly the sent text and public. No idempotent re-send. **Next (T1.13):** add the op to `Action` and route it to this writer. **Gotchas:** more reply templates go in `REPLY_TEMPLATES`.
- **2026-10-24, Artin (#124).** Branch `fix/124-lost-undo-regressions`. The read-back fix landed in #125. Soroush's review of this PR found a **cancelled** newer revision lost recovery of an older revision's unresolved undo: its read-only pass held it, but the worker's cancelled branch returned success (job completed, never retried), and the reaper only revisited a cancelled run with an in-flight send of its *own* hash. Now `RunOutcome.unresolved` is set for any read-only pass (cancelled or refused) that leaves a send of the plan in flight under any revision; the worker's cancelled branch throws `RetryLater` on it (the run stays `cancelled`); and the reaper's cancelled-run selection and operator hand-off count in-flight sends of any revision of the plan (`plan_versions`). Regressions: refused (revoked, mixed-field teammate conflict, Postgres lifecycle) and cancelled newer revisions with an absent or unreadable older undo, through a real pg-boss delivery and the real reaper.
- **2026-10-24, Artin (#121 follow-up).** Branch `fix/refused-lost-undo`. Soroush's #123 review found a refused (or cancelled) newer revision could leave an older revision's lost undo unresolved even when it landed: the read-only pass returned before undo recovery, because the new hash has no confirmed receipt for the patch. Now a read-only `step()` reads a sent, unsettled undo (`sentUndo(...).read`) through `settleFromUndo`, which only reads, records or holds; compensation stays off, so no fresh undo is ever sent from a read-only pass. Regression tests for lost undos on refused runs (this hash and a newer revision, landed and not) and a cancelled newer revision.
- **2026-10-23, Artin (fix #121).** Branch `fix/121-recover-after-refusal`. Two paths still marked a run `failed` while a send of it had no receipt. (A) A delivery that can't get the plan lock on its last try used to mark the run failed; the holder could then strand its sends. Now it always throws `RetryLater` and leaves the run `applying`; the reaper re-enqueues it (bounded) and hands it to an operator. (B) A refused admission (grant expired, revoked or changed) used to return at once. Now, when a send of the run is still in flight, it first runs the read-only pass against the stored, hash-checked plan (`admit(…, readOnly)`), the same pass a cancelled run gets: reads only, never a send or replay. If a send is still unresolved after it, `RunOutcome.unresolved` makes the worker keep the run retryable. A read-only pass now logs `run.reconciling`, not `run.admitted`. **Gotchas:** nothing in the worker marks a run failed any more; only a clean refusal, the executor's own outcome or the reaper's hand-off does.
- **2026-10-23, Artin (#104 follow-up).** Branch `fix/retry-duplicate-receipts`. A run retried after errors used to settle its held and skipped steps again on every pass (duplicate receipts) and write `run.finished` each time while still `applying`. Now `JournalPort.runReceipts(runId)` (optional) lists the receipts the run wrote since it last finished; a retry that would settle a step the same way (outcome, hold reason, provider object; never a confirmed one or one with a transition or binding) writes nothing. A pass that stopped on an error writes `run.stopped`, not `run.finished`; the web shows it as "stopped… will be retried". A new run of the same hash still writes its own receipts.
- **2026-10-23, Artin (fix #106).** Branch `fix/106-ordered-event-cursor`. With case lanes (T3.7) two writers of one run can append events at once, and `run_events.seq` is a global sequence, so a commit could land behind a reader's cursor and be skipped for good. Every event writer now goes through `insertRunEvent` (`packages/db/src/events.ts`): it takes a per-run transaction advisory lock before allocating `seq` and holds it until commit, so per run seq order is commit order. The journal's `appendEvent` and the reaper both use it. **Gotchas:** a new writer of `run_events` must use `insertRunEvent`, never a bare insert. The API's `seq > after` read is unchanged (T2).
- **2026-10-23, Artin (fix #104).** Branch `fix/104-retry-returned-errors`. The executor catches unexpected errors (a failed journal write, an adapter bug) and returns them as `RunOutcome.error`; the worker used to write that run's state (often `held`) as final, so an effect could land with no receipt and no later delivery would look at it. Now `handleApplyJob` throws `RetryLater` on a returned error, leaving the run `applying`; the redelivery reconciles through the journal and reads. Past the last try the run stays `applying` (for a thrown error too), so the reaper re-enqueues it up to `MAX_REAPS` times and then hands it to an operator; marking it `failed` there would leave an unreceipted send nobody looks at. **Gotchas:** each pass re-settles held/skipped steps, so a deterministic error writes duplicate non-confirmed receipts and a `run.finished` event per pass (the web keeps the latest receipt per action); a follow-up. A cancelled run's read-only pass is retried the same way and stays `cancelled`.
- **2026-10-22, Artin (fix #99).** Branch `t3/recovery-only-dependents`. The dependency bypass from #92 (an action already sent keeps its record after a predecessor is undone) now only recovers: `step(action, recoveryFor)` reconciles an in-flight send by a read, but a negative read holds it as `unresolved_outcome` instead of an idempotent replay, and nothing is ever freshly prepared or sent (a defensive `skipped_dependency` before the send path). A repeated pass adds no duplicate hold. **Gotchas:** the defensive skip isn't reachable from today's attempt histories (a send past an undone predecessor needs a non-rejected earlier attempt, which `step()` settles first), so no test pins it.
- **2026-10-22, Artin (T3.7).** Branch `t3/T3.7-concurrency`. `ExecutorDeps.caseConcurrency` (default 1) runs independent cases at once:
  - **Grouping:** `caseGroups(manifest)` joins cases into one sequential group when they touch any record in common: a record one writes, a record any of them cites as evidence, a customer or requester their queries cover, or a cross-case dependency. So one case's write never looks like outside drift to another case's guard, and two writes to one record never run side by side. With concurrency 1, the exact global topological order is kept.
  - **Run state:** in-flight attempts are tracked as a set across cases. An unexpected error stops new actions in every case, and a cancel stops every lane before its next action.
  - **Backoff:** a 429 in one case no longer blocks the others.
  - **The worker** uses `EXECUTOR_CASE_CONCURRENCY` (default 4).
  - **Tests:**
    - Fake: the limit is honored and actually exceeded 1; results match a sequential run; backoff doesn't block other cases; a shared ticket is never written concurrently; error and cancel stop all lanes; grouping.
    - Postgres: the worker with concurrent cases.
    - Live Era: four cases at once, each effect once (`concurrency.test.ts`).
  - **T3 is complete.**

- **2026-10-22, Artin (T3.6).** Branch `t3/T3.6-cancel-reaper`.
  - **Cancellation:**
    - `requestCancel` and `POST /api/runs/:id/cancel` move an `approved` or `applying` run to `cancelled`.
    - The executor checks `ApplyStore.runCancelled` before admission, before every step and before every send, retries included. It stops there and the run ends `cancelled`.
    - Receipts keep every effect that did happen; nothing is rolled back. An earlier send whose outcome is unknown stays `unknown_outcome` and is never re-sent.
    - **A cancelled run still owes a read-only reconcile.** If a send was left in flight (the worker died after dispatch), the job's next delivery, or the reaper, which also picks up cancelled runs with in-flight attempts, runs a reconcile-only pass. It resolves those attempts by reading and writes their receipts. It never sends, and the run stays `cancelled`. A read that finds nothing never closes the attempt, because no replay will follow; it holds once and isn't re-held by later passes. The reaper re-enqueues any stuck run (approved, applying, or cancelled with a send in flight) at most `MAX_REAPS` (12) times, recording each as a `run.reaped` event. After that it writes one `run.needs_operator` event, marks an approved or applying run `failed` (so applying its hash again starts a new run, which resumes from the journal), logs the run IDs in the worker, and stops. A cancelled run is handed off only while a send is still unresolved. The web timeline labels both events.
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
