# Delivery plan

Four feature tracks (see [AGENTS.md](../AGENTS.md#tracks)). The task tables in [`docs/tracks/`](tracks/) are the source of truth for every task, its milestone and its blockers; the [blocker board](https://github.com/SoroushRF/Rehearsal/blob/status/BLOCKERS.md) is generated from them ([how](blockers.md)).

## Milestones (from November 2026)

Set by [decision 0017](decisions/0017-determinism-replay-and-deferrals.md); execution semantics are in [0018](decisions/0018-dispatch-ownership-and-obligation-claims.md), [0019](decisions/0019-plan-hash-commitments-and-manifest-v2.md) and [0020](decisions/0020-external-agents-mcp-and-submission.md). Milestones have no dates.

| Milestone | Done when |
|---|---|
| **M6 Engine Core** | The single-plan engine is provably safe under concurrency, crashes and upgrades: one dispatch owner per operation (T3.40), durable obligation claims across plans (T3.27, T4.29), causal receipt order and typed verification (T3.36, T3.37), offline record and replay in CI (T3.38), seeded fault simulation (T1.69), pinned plan hashes (T4.30), enforced v1 commitments (T4.34), the operation registry with a non-billing fixture operation (T3.21, T3.22), and the open baseline evidence reruns (T1.35, T1.36, T4.13). |
| **M7 Read-Only Proof** | The planner builds a plan from a Stripe test-mode account and a Zendesk sandbox with read-only credentials and no Era world (T1.59, T2.35), and shadow mode checks a batch that already ran (T1.61, T4.31). Planner hardening from the code review (T1.63–T1.68) lands here. |
| **M8 Bring Your Own Model** | An outside agent submits a plan through the shared intake API or MCP and it is reviewed, approved and applied like any other (T2.33, T2.34), under PlanManifest v2 (T4.35), with an offline verifier anyone can run (T4.36) and the shared provider rate budget (T3.30). |
| **M9 Real Accounts** | Writes go to real provider accounts: Stripe refund states and webhooks (T3.23, T3.24), the Zendesk adapter (T3.25), database-enforced tenancy and history (T3.28), hash-chained receipts (T3.29), signed grants (T2.38), recovery after a database restore (T3.41) and more than one currency (T2.40). |

Work with no milestone is deferred; its issue says what it waits for.

## Order of work

1. **Baseline evidence first.** Rerun the held-out sets on Era (T1.35) and fix the misrouted rehearsal worker (#323) so the T4.13 gate can pass; then write the benchmark report (T1.36). These need no model and no spending.
2. **Engine safety holes (M6).** Dispatch ownership (T3.40, then T3.39), obligation claims (T4.29, then T3.27), grant liveness (T3.32), refusal handling (T3.31), the stale-revision check (T2.42) and the guard gaps (T4.32, T4.33).
3. **Determinism machinery (M6).** Split the executor and extract `decideStep` (T3.21), causal order and provenance (T3.36, T3.37), then record and replay (T3.38), seeded simulation (T1.69), golden hashes (T4.30) and admission commitments (T4.34).
4. **Read-only proof (M7).** Start with the Stripe half on the existing reader (first slice of T1.59), then the credential broker's read-only slice (T2.35) and shadow mode (T1.61).
5. **Outside plans (M8)**, then **real accounts (M9)**.

Proposed rows (T3.36–T3.42, T4.34–T4.36) need agreement from the owning tracks before implementation; each row links its decision.

## What is proven and what is not

Every result carries a commit and an evidence label. Older results keep the caveats in [the handoff](handoff-2026-11-03.md#open-work-in-priority-order): the submission runs were made on the submission commit plus uncommitted changes, the raw JSON is not committed, and the B11 report on `main` has no exact SHA.

| Claim | Evidence | Where |
|---|---|---|
| Approved-refund lost-response recovery against real Stripe test mode: one refund, one journaled attempt (T3.18) | `native_stripe_test`, commit `06b961a`, 2026-10-25; test mode only, Zendesk was the in-memory stand-in | [`docs/evidence/native-stripe-recovery.json`](evidence/native-stripe-recovery.json) |
| Native Stripe read conformance: account binding, livemode, identity, amounts, complete pagination (T1.24) | `native_stripe_test`, 2026-10-25 | T1.24 row, #215 |
| Scorecard on Era with a scripted planner: Rehearsal 27/29, competent baseline 21/29 at the submission tag (T1.25, T1.33) | `era_integration`, 2026-10-29, with the caveats above | `evals/scorecard/results/submission-c1.txt` |
| Same customer, new charge on another invoice: passes in all four modes on `main` (T1.34) | `era_integration`, 2026-10-29; no exact SHA | `evals/scorecard/results/main-b11.txt` |
| Precedent memory and app gates against the hosted Agent Memory service (T1.49–T1.55) | hosted gate runs, 2026-11-02/03; scripted model and testkit planning reads; not a deployed-app acceptance run | [agent-memory.md](agent-memory.md) |
| Held-out sets ho1–ho3 (T1.35) | **Not proven.** One partial run; its competent results are invalid until rerun | T1.35 row |
| Integrated isolation and recovery gate (T4.13) | **Not passed** on `ca95d7a`: a misrouted rehearsal worker is not refused (#323) | T4.13 row |
| Two plans on one charge, crash at every point, upgrade with an in-flight send | **Not proven.** Single cases are fixture-tested; no seeded harness yet (T1.69, T3.27, T3.40, T3.42) | M6 rows |
| Offline replay of a real run | **Not possible yet** (T3.36–T3.38) | decision 0017 |
| Planning against real provider accounts; real Zendesk; outside agents | **Not run** (M7, M8) | M7 and M8 rows |
| Reviewer effort | **Modelled only**, never measured on people | T1.6 row |

## Technical don'ts

- No rewrite of the executor in another language, no TLA+, no Cedar and no table-backed worker leases until the triggers in [decision 0017 §4](decisions/0017-determinism-replay-and-deferrals.md#4-explicit-deferrals-and-unlock-triggers) are met. That table is the list of deferred work and what unlocks each item.
- No second real (non-billing) vertical before T3.21, T3.22 and T4.35 land.
- No new infrastructure (Redis, Kafka, Temporal, LangGraph, a vector or graph DB, extra microservices) without a decision record.
- No ML training or serving ([decision 0008](decisions/0008-ml-out-of-hackathon-scope.md)).
- No paid model run, cloud GPU or live payment account without the owner's go-ahead in that session; Stripe keys are `sk_test_` only.
- Agent Memory stays an advisory recall index; Postgres `precedent_events` is the only authority.
- No breaking manifest change outside PlanManifest v2 (T4.35); v1 golden hashes never change.

## History: hackathon milestones M1–M5 (October 2026)

These milestones are closed. The Build North submission is tag `submission-2026-10-25`.

| Milestone | Date | Done when |
|---|---|---|
| **M1 Thin slices** | Mon Oct 20 | The Era day-one gate passes. Contracts v1 are frozen. Each track's first slice works on fixtures. |
| **M2 Real loop** | Tue Oct 21 | Two customers go through real plan → review → approve → apply → receipt against Era. |
| **M3 Hero moments** | Wed Oct 22 | Phantom hold, teammate-edit conflict, 429 retries and lost-response recovery all pass on Era. |
| **M4 Freeze** | Thu Oct 23 | ~20 acceptance scenarios and the first full scorecard. |
| **M5 Ship** | Fri Oct 24 – Sat Oct 25 | Final measured runs, deployment smoke test, submission. |

The October trim decision was reversed by [decision 0009](decisions/0009-reopen-full-scope.md) (full scope, without ML per [0008](decisions/0008-ml-out-of-hackathon-scope.md)). The Oct 24 beyond, killer and benchmark tasks are recorded in [beyond.md](beyond.md).

## Open decisions

See [decisions/0001](decisions/0001-open-team-decisions.md) for the open "soft signal" question (can advice clear a soft hold). Mandatory holds are never released by a model.
