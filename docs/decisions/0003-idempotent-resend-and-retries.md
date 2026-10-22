# 0003: Retries and idempotent re-sends (T3.4)

**Status:** accepted 2026-10-22 (Artin, T3). Please raise objections in team chat or a PR.

## Context

AGENTS.md says an unknown outcome "is reconciled through reads, never blindly re-sent". T3.4 asks for retries on 429s and transient errors. A 5xx, a timeout, or a lost response may have committed, so it is an unknown outcome.

## Decision

1. **429 (and any refusal marked retryable):** it definitely had no effect, so we re-send the identical journaled bytes. Each re-send is a new attempt row.
   - In-run: bounded backoff (default 4 sends, 250 ms doubling, a 10 s cap) that honors Retry-After. A Retry-After above the cap ends the run's retries for that step.
   - A later run may send a step whose last attempt was a 429.
2. **Other 4xx (validation, permission, conflict):** never retried, in this run or a later one.
3. **Unknown outcomes:** re-sent only when the provider declares `idempotentResend` for the action. Today that is only `stripe.refund.create`. The same idempotency key and the same bytes either create the refund once or replay the original response, so the re-send is a read through the provider's own dedupe, not a blind re-send.
   - When the replay confirms, the earlier unknown attempts are marked `reconciled`.
   - Zendesk notes are appends and are never re-sent this way. Zendesk patches aren't either: a guarded patch that already landed would answer 409 and be misread as rejected.
   - Everything else waits for T3.5 (reconcile through reads).
4. Guards run before the first send and again after backoff before a fresh send following a definite refusal. An unresolved earlier send is resolved only by identical provider-idempotent replay; its own possible effect must not be mistaken for external drift.

5. If any send of a step had an unknown outcome and none confirmed, the step is `unknown_outcome`, even when a later re-send was refused (a 429, say). Money may have moved, so it is never reported as `rejected`.

## Consequences

- A lost refund response is usually resolved within the run. The `unknown-outcome` bundle still needs T3.5 for the crash-and-restart case.
- Real Stripe also caches a request's 500 under its key and replays it. On real Stripe, then, the re-send resolves lost responses and transport errors, not genuine 500s. Era's injected faults fire before the handler and are not cached.
- The replay depends on the provider keeping the key. Real Stripe keeps keys for a limited time, and an Era tenant reset clears the cache, so never reset a world that is applying.

## Addendum (T3.5): reconcile through reads

- **What the states mean:**
  - `reconciled` means a read **found** the effect. The executor treats it like `confirmed`.
  - `rejected` with no `providerStatus` means a read found no visible effect. Only an identical provider-idempotent replay is allowed; it does not prove the original request terminated.
- **Negative reads (corrected by review item 4):** a request can still land after a read that missed it. Age alone is never proof that it terminated. After `reconcileAfterMs` (default 60 s), only identical content with explicit provider idempotency support may be replayed. Unknown Zendesk notes and patches remain held until a positive read resolves them, regardless of age. Legacy negative-read rejection rows do not authorize non-idempotent re-sends.
- **How each write is reconciled:**
  - **Stripe refunds:** matched by `metadata.rehearsal_op`, paging through all of the charge's refunds.
  - **Zendesk notes:** matched by their operation marker, across every page of comments.
  - **Zendesk patches:** applied if the ticket holds our values. Not applied only if its `updated_at` still equals the stamp we sent. Anything else is indeterminate and held, because we can't tell whose write won.
- **Atomicity:** the in-run replay's `reconciled` marks are now written in the same atomic settle as the confirmed receipt.
- **Content first:** operation keys don't include content, so a found effect confirms the step only if the in-flight attempt's content matches this revision's. If a revision changed the amount or text, the effect is recorded (`reconciled`) and the step is held `approval_invalid`. It is never handed the old refund.
- **Known limit (patches):** at 1-second precision, a negative read cannot establish whose write won. Recovery now holds instead of re-sending. The native stamp's documented same-second limitation still applies to an initial guarded write.
- **Clock:** the window compares the executor's clock with `dispatchedAt`. The worker must use wall time.
