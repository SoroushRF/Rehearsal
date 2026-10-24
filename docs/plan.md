# Delivery plan

Team of four on four feature tracks (see [AGENTS.md](../AGENTS.md#tracks)). Dates are Toronto time. This plan is about a day behind the original calendar in `docs/source/build-plan.md`.

## Milestones

| Milestone | Date | Done when |
|---|---|---|
| **M1 Thin slices** | Mon Oct 20 | The Era day-one gate passes. Contracts v1 are frozen. Each track's first slice works on fixtures: UI renders a fixture plan, executor runs the happy path on a fake provider, read adapters return real observations, guards are unit-tested. |
| **M2 Real loop** | Tue Oct 21 | Two customers go through real plan → review → approve → apply → receipt against Era. Thin slice deployed. **Trim decision** that evening (see below). |
| **M3 Hero moments** | Wed Oct 22 | Phantom hold, teammate-edit conflict, 429 retries and lost-response recovery all pass on Era. ML go/no-go decided. |
| **M4 Freeze** | Thu Oct 23, evening | ~20 acceptance scenarios and the first full scorecard. Extensions merged only if they passed their gate. Tag `freeze-oct23`; only `fix/` branches after this. |
| **M5 Ship** | Fri Oct 24 – Sat Oct 25 | Final measured runs, deployment smoke test, 2-minute video, Devpost page. Submit **Oct 25 afternoon** and tag `submission`. Hard cutoff is 11:59 PM ET. |

## Trim decision (Oct 21 evening)

> **Reversed on Oct 24** by [decision 0009](decisions/0009-reopen-full-scope.md): the full scope is back, without ML ([0008](decisions/0008-ml-out-of-hackathon-scope.md)). The freeze is lifted, and deploy and the video wait for the full version. The correctness checks below still hold.

If M2 isn't met, switch to the trimmed scope:
- No Slack, SurrealDB, Expo or model serving.
- The ML experiment still finishes as a report.
- All four tracks put their remaining time into the acceptance scenarios, deployment and the video.

Trimming removes features, never correctness checks. These must stay:
- Refusing without an approval, and refusing a changed hash
- The phantom case
- Exact retry plus reconciliation
- Honest partial outcomes

## How the tracks depend on each other

The task-level graph, with live status and current blockers, is on the [blocker board](https://github.com/SoroushRF/Rehearsal/blob/status/BLOCKERS.md) (how it works: [blockers.md](blockers.md)).

```text
contracts v1 (frozen M1) ──► everyone

T1 read adapters ──► T4 guards (re-read, re-query)
T1 planner       ──► T2 review UI (real plans replace fixtures at M2)
T2 approval      ──► T3 admission (grant + hash check)
T3 executor      ──► T4 guards plug into admission; compensation hooks
T4 inject scripts──► T1 scorecard traps, T2 demo
```

Until a dependency lands, build against `@rehearsal/testkit` fixtures and the ports in `packages/core/src/ports.ts`.

## Oct 24 extension plan

After full acceptance, benchmarking, UI and beyond implementation proceed together through the shared contracts. The [beyond delivery map](beyond.md) contains the agreed 25 tasks, owner counts, cross-track handoffs and cut line. The task tables remain the canonical dependency graph.

- **15 beyond:** exact stored-plan execution in disposable worlds, independent reports, review UI and operator task testing.
- **8 killer:** optional native Stripe sandbox proof, stronger benchmark/precedent evidence and fresh Clerk verification. They do not block the main beyond engineering gate.
- **2 additional benchmark:** extend the full-operation scorecard and publish an early full baseline plus frozen-head comparisons. Three killer tasks also carry the benchmark label; they are counted within the eight.

T4.13 is the integrated beyond acceptance gate. T1.28 captures the full baseline early, then finishes after that gate; T2.7 now waits for deployment and T1.28 before final recording/submission. Operator recruitment, native sandbox access and real Clerk verification remain separately labelled external gates. No ML training/serving is added.

## Daily rhythm

- **Morning, 10 minutes:** each owner says yesterday / today / blocked. Pick the integrator of the day.
- **During the day:** small PRs, reviewed within about 2 hours.
- **Evening:** the integrator runs the end-to-end demo on `main` and posts the result. Owners update their track's handoff log.

## Open decisions

See [decisions/0001](decisions/0001-open-team-decisions.md):
1. Can the model clear soft holds?
2. ~~Slack in the trimmed scope?~~ Settled: in ([0009](decisions/0009-reopen-full-scope.md))
3. Closing line
4. Pivot clause
5. Deploy target

Settle these at M1.
