# 0017: Determinism, offline replay, and explicit deferrals

**Status:** accepted 2026-11-25 (Soroush, T1). Captures the post-hackathon technical direction from the November 2026 architecture review. Implementation tasks are tracked across M6–M9; cross-track execution semantics are detailed in [0018](0018-dispatch-ownership-and-obligation-claims.md), [0019](0019-plan-hash-commitments-and-manifest-v2.md) and [0020](0020-external-agents-mcp-and-submission.md).

## Context

Rehearsal's primary differentiator is deterministic execution: once a reviewer approves an exact plan hash, a model-free engine applies it safely despite retries, crashes, and live state drift.

Code review of `main` (`4fc2f19`) showed that while the single-plan protocol is strong (journal before dispatch, compare-and-set transitions, exact-byte retries, read reconciliation, and native Stripe test-mode lost-response recovery in [`docs/evidence/native-stripe-recovery.json`](../evidence/native-stripe-recovery.json)), **an actual run cannot yet be replayed offline**:

1. The step guard discards fresh reads after returning a hold reason or `null` (`packages/core/src/step-guard.ts`).
2. Production supplies random UUIDs (`apps/executor-worker/src/worker.ts`) and defaults to four concurrent case lanes (`apps/executor-worker/src/main.ts`).
3. Receipt queries sort by worker timestamp then random UUID (`packages/db/src/journal.ts`), and both a read-back-confirmed write and an inconclusive read-back record `outcome: "confirmed"` with the distinction buried in `limitations` prose.
4. Several high-effort ideas (a Rust/WASM verifier, a Go executor rewrite, TLA+, AWS Cedar, table-backed worker leases, and a second production vertical) were weighed against fixing real safety holes first.

This record fixes what "deterministic" means in Rehearsal, settles three open backlog calls, and defines concrete triggers for deferred work so the team avoids premature rewrites while keeping expansion paths open.

## Decision

### 1. The determinism contract

Rehearsal makes three exact, testable claims—never a blanket claim that external SaaS APIs are deterministic:

1. **Deterministic compilation.** Given the same approved inputs, policy content, templates, and schemas, Rehearsal produces the same normalized plan, mandatory dependency graph, server-derived risk/protection labels, and canonical SHA-256 digest.
2. **Deterministic offline replay.** Given the same approved manifest, execution rules, prior journal, clock, generated IDs, and ordered external observations/provider answers, replaying the engine offline with zero network calls produces identical authorization decisions, holds, prepared request bytes, and receipts.
3. **Deterministic fail-closed uncertainty.** When the outside world is ambiguous (lost response, partial page, concurrent edit, pending settlement), the engine never guesses and never asks a model to improvise; it transitions to an explicit typed uncertainty state with bounded, auditable recovery rules.

### 2. Proof machinery and engine generalization

- **Keep `executeRun(job, deps)` on TypeScript, Postgres, and pg-boss.** `packages/core` already injects its I/O ports. Extract modules mechanically and isolate a pure `decideStep` transition function with an exhaustive table test (#428) rather than rewriting the stack.
- **Record and replay runs offline.** Land causal receipt ordering (`T3.36`), typed receipt verification provenance and guard-read fingerprints (`T3.37`), and offline record-and-replay (`T3.38`) so CI replays stored recordings and catches regressions before release.
- **Seeded Deterministic Simulation Testing (#448).** Expand the fault harness to explore concurrent lane schedules, crashes at every port boundary, provider errors, revocations, and competing plans from reproducible PRNG seeds, paired with real-Postgres companion tests.
- **Prove the extension boundary before adding a second real vertical (#429).** Move the six existing operations behind an operation-type registry that derives `protection` and `compensation` server-side, and prove generality with a **seventh, non-billing fixture operation** running through admission, guards, journaling, reconciliation, and receipts with zero engine edits.
- **Evidence discipline stays unchanged.** Every published result carries its commit SHA, raw output, and evidence label (`fixture`, `era_integration`, or `native_stripe_test`). Baseline proof runs (#323 → #175 and #180/#280 → #281) run first, alongside repo housekeeping.

### 3. Settled November 2026 backlog decisions

1. **Credit refusal fallback (#285, PR #356).** Keep `main`'s four-reason `REFUND_INSTEAD` rule (`packages/planner/src/tools.ts`): when a customer's Stripe balance is in another currency so a CAD balance credit cannot apply, refunding the CAD duplicate charge to the card is valid under policy (`packages/core/src/policy.ts`) and avoids failing the entire plan as incomplete. Foreign-currency charges remain refused. Reopen #285 to align its acceptance criteria and add `run-summary@2` for credit-only and mixed credit+refund summaries; close stale PR #356 unmerged.
2. **Shared provider-account rate budget (#437).** Split the shared rate budget from full OpenTelemetry tracing. Do not block M6 engine safety or the first single-worker read-only test-mode proof (#415, #417) on #437; require the rate-budget slice as an M8/M9 gate before multi-worker or production org accounts share live provider quotas.
3. **Local full-stack precedent checklist (#238).** Keep #238 open for its remaining two-signed-in-user and second-version checks rather than folding it into #359.
4. **Milestones.** Move post-hackathon work off `M5 Ship` into **M6 Engine Core**, **M7 Read-Only Proof**, **M8 Bring Your Own Model**, and **M9 Real Accounts**.

### 4. Explicit deferrals and unlock triggers

Nothing below is rejected permanently; each waits for a specific trigger:

| Item | Status | Unlock trigger |
|---|---|---|
| **Rust/WASM offline & browser verifier** | Deferred | #439 canonical stored-byte hashing and `T4.36` TypeScript CLI land, and a second-language SDK or independent auditor needs a non-Node verifier. |
| **Go or Rust single-binary executor** | Deferred | A buyer requires running the write-key executor inside their own network or their security review rejects Node's dependency surface. |
| **Real second non-billing production domain & generalized Guard/Workflow DSL** (generic `ResultPath`s, declarative guard AST, generic approval seats, progressive batch rollouts) | Deferred past M7 | #428, #429 (7th non-billing fixture op), and `T4.35` (`PlanManifest` v2) land, proving the extension boundary cleanly before onboarding a second live vertical. |
| **TLA+ / PlusCal formal specification** | Deferred | Pure `decideStep` exhaustive tests (#428) and seeded DST (#448) expose protocol-level liveness or concurrency ambiguities not settled directly in code. |
| **AWS Cedar policy engine** | Skipped | Cedar cannot natively express the backtracking distinct-seats check (`packages/authz/src/decide.ts`) or plan totals. Extend `packages/authz` with `gte`/`lte` instead. |
| **Table-backed worker leases** | Deferred | Deployment behind a transaction pooler (e.g., PgBouncer transaction mode) or running multiple concurrent jobs per executor worker. |
| **WebAuthn approver-held signing keys** | Deferred | IAM-signed grants (#424) and an independently verifiable display/CLI (`T4.36`) exist first. |
| **ML training / serving** | Out of scope | Unchanged ([0008](0008-ml-out-of-hackathon-scope.md)). |

## Consequences

- "Deterministic" becomes an artifact CI proves by replaying recorded runs and seeded fault schedules rather than an untested label.
- The team stays focused on M6–M9 without stalling on a language rewrite or sprawling connector list, while #428, #429, #439, and `T4.35` preserve a clean path to non-billing domains and cross-language verification.
- SurrealDB Agent Memory stays frozen as an advisory recall index; Postgres `precedent_events` remains the sole authority (#445).
