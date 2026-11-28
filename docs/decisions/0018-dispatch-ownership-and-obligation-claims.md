# 0018: Dispatch ownership, cross-plan obligation claims, and causal receipts

**Status:** proposed 2026-11-25 (Soroush, T1). Governs T3 journal/executor/locking and T4 obligation guards; requires review from T3 (@ArtinMe) and T4 (@skhdemo) before implementation of `T3.36`–`T3.41` or any change to executor, journal, or guard code.

## Context

The single-plan executor protects an approved revision against duplicate sends under normal operation, but code review of `main` (`4fc2f19`) found five gaps across concurrent plans, lock loss, receipt ordering, and database restores:

1. **Cross-plan double remedies (#434, #438).** `lockPlan` locks `(orgId, planId)` (`packages/db/src/apply-store.ts`), and `operationKey` includes `planId` (`packages/core/src/executor.ts`), while `obligationId` is planner-supplied (`packages/planner/src/tools.ts`). Two separate plans targeting the same duplicate charge can pass `readRemedyHold` concurrently and both dispatch.
2. **Lock loss and cross-revision races.** `lockPlan` holds a Postgres session advisory lock on a dedicated client whose `error` handler only logs (`packages/db/src/apply-store.ts`), and `maySend` in compensation checks only cancel and grant validity (`packages/core/src/executor.ts`). Separately, a newer revision ignores an older revision's `prepared` row (`packages/core/src/executor.ts:1678`). At the same time, a blanket "one open attempt per key" DB constraint would break three legitimate existing flows: superseding a never-sent `prepared` row when preconditions change (`executor.ts:1831`), Stripe exact-byte retries while a predecessor is `unknown_outcome` (`executor.ts:2102`), and compensation undo retries that mark a new undo `dispatched` before closing an earlier one (`packages/core/src/compensation.ts:578`).
3. **Non-deterministic receipt ordering.** `receiptsFor()` orders by `(recordedAt, id)` (`packages/db/src/journal.ts:169`), where `id` is a random UUIDv4 and `recordedAt` comes from the worker clock. `overlayFromReceipts()`, `repairScope()`, `compensationTargets()`, and `applyLocked()` all fold receipts in last-write-wins order, so equal timestamps or clock skew across workers can flip the effective latest receipt.
4. **Verification strength buried in prose.** A confirmed write whose post-write `readBack()` was inconclusive still writes `outcome: "confirmed"` and records the caveat only as a string in `limitations` (`packages/core/src/executor.ts:1994-2026`).
5. **Restore-time append duplication & IAM clock boundary.** First-send appends (notes/replies) never inspect the provider for an existing marker, `findMarkedComment()` stops on the first match (`packages/providers/src/write.ts:202`), and private-note reconciliation checks the marker without verifying body equality (`write.ts:453`). Separately, `scenarios/authz/rehearsal-authz.v1.json:234,255` checks strict `env.now > item.grantedAt` while executor admission accepts equality (`executor.ts:597`), and "grant is live" logic is duplicated across five call sites.

## Decision

1. **Server-derived excess-charge obligation claims (#438, #434).**
   - Derive the business obligation key on the server from `(orgId, verifiedProviderAccountId, excessChargeId)`. Do **not** collapse an entire invoice or duplicate group into one claim: for a triple duplicate (earliest paid original `A` + excess charges `B` and `C`), `tools.ts:645` pins the original to `A` and `coverage.ts:69` expects two separate remedies (`B` and `C`).
   - Validate the full duplicate proof (customer, invoice, earliest paid original, amount, currency, and complete population enumeration) from trusted reads so a bare charge ID submitted externally proves nothing. Until `PlanManifest` v2 (`T4.35`) pins the provider account in the manifest, derive the account identity from the org's verified connection (#421).
   - Keep transport `operationKey` separate from the business claim key so in-flight attempts never lose key continuity across upgrades.
   - Reserve the obligation via a durable Postgres claim row inserted atomically with the first attempt (unique per org + account + obligation) and held through `pending` and `unknown_outcome` states, so refunds and balance credits compete for the same claim across all plans.

2. **One transactional dispatch owner per operation (`T3.40`, land before `T3.39`).**
   - Enforce safety in Postgres rather than relying on advisory locks alone: give each logical operation one transactional dispatch owner, add an explicit terminal state for superseded never-sent `prepared` rows, and model explicit forward exact-byte retry lineage and compensation undo-key lineage so legitimate retries continue working cleanly.

3. **Active stop on plan lock loss (`T3.39`, layered on `T3.40`).**
   - Treat lock-loss signaling as a best-effort stop optimization on top of `T3.40`'s DB guarantee. Perform an active health check on the lock connection (because a silently dead socket may emit no error event) and propagate lock loss to stop first sends, retries, concurrent lanes, and `maySend` in compensation.

4. **Causal receipt sequence (`T3.36`) and typed provenance (`T3.37`).**
   - Add a transactional monotonic `seq` column on receipts at settlement and migrate every latest-receipt consumer (`journal.ts`, `step-guard.ts`, `repair.ts`, `compensation.ts`, and rehearsal). Do not fabricate historical causal order during backfill; handle legacy ambiguity explicitly.
   - Add a typed verification/provenance field on `Receipt` via an additive contracts PR distinguishing write-response-only, read-back-verified, reconciled, inconclusive, and contradicted outcomes, plus guard-read fingerprints and a reference to retained replay inputs for `T3.38`.

5. **Append recovery after database restore (`T3.41`, M9).**
   - Upgrade marker reconciliation to inspect the full comment/history set (detecting duplicates rather than stopping at the first hit) and verify exact body/visibility on both private notes and public replies. Coordinate with #433 (removing customer-visible markers from public replies) and #453 (operator resolution queue for ambiguous cases).
   - Verify with a database restore-and-reconcile drill where outbound dispatch stays disabled until reconciliation completes against the surviving provider state.

6. **Unified grant liveness and same-millisecond IAM fix (#452).**
   - Add `gte`/`lte` operators to `packages/authz/src/decide.ts`, update `run:admit` in `scenarios/authz/` to `env.now >= item.grantedAt` (keeping expiry exclusive), consolidate the five duplicated grant-liveness checks into one helper, and re-check *all* required seats in dual-approval runs before every send.

## Consequences

- Two competing plans targeting the same charge cannot both authorize a remedy, and a worker that loses its advisory lock cannot silently race a replacement worker into a double send.
- Every downstream consumer (guard overlay, compensation, repair, offline replay, and hash-chained receipts in #436) reads receipts in one deterministic causal order.
- New tasks required (pending T3/T4 owner agreement): `T3.36`, `T3.37`, `T3.39`, `T3.40`, `T3.41`; amended existing issues: #434, #438, #452, #453, #433, #436.
