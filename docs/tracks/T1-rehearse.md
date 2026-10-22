# T1 Rehearse: the agent plans in a copy of the company

**Owner:** see the [roster](../../AGENTS.md#roster).

**Demo moment:** a billing bug overcharged customers. The agent investigates Stripe and Zendesk in the planning world and produces a reviewable plan. It never touches the operational world.

**Owns:**
- `infra/compose.yaml`
- `scenarios/billing/` data and fixtures
- `packages/providers` read side (observe, query)
- `packages/planner`
- `apps/planner-worker`
- `evals/` scorecard runner

**Provides to others:**
- Real `Observation` and `QueryObservation` objects. T4 re-runs them at apply time.
- Real `PlanManifest`s that replace the fixtures in T2's UI.
- Seeded worlds plus `demo:reset`.

## Acceptance

- `pnpm smoke:era` is green, and the conformance results are in `docs/capability-matrix.md`.
- The planning and operational worlds start identical for the incident cohort. This is verified by comparing reads.
- The planner produces a manifest that passes `validateGraph` and `evaluateBillingPolicy` for 5–10 customers. It records its model ID, prompt version and tool-schema hash.
- The planner worker refuses to start with operational or admin credentials.

## Tasks

| ID | Task | Milestone | Done when | Issue | Blocked by |
|---|---|---|---|---|---|
| T1.1 | Era day-one gate: writable worlds, refund idempotency, guarded Zendesk update, private note, tenant reset | M1 | Conformance tests pass with `ERA_CONFORMANCE=1`; capability matrix written | #2 | — |
| T1.2 | Seed the incident: 5–10 overcharged customers, plus benign controls, injected identically into both worlds; `pnpm demo:reset` | M1 | Reset → identical worlds every time; fixtures copied from real GET responses | #3 | T1.1, T1.9 |
| T1.3 | Read adapters: get charge, get ticket, and the two query predicates, with full pagination and `complete` set honestly | M1 | Unit tests against recorded responses, plus one live test | #4 | T1.1 |
| T1.4 | Typed planning tools that record evidence and add dependency edges themselves (the model can't define its own evidence) | M2 | A tool call produces observations and actions matching contracts v1 | #5 | T1.3 |
| T1.5 | Bounded Claude tool loop: pinned model, versioned prompt, step limit, no shell, browser or raw HTTP; planner worker consumes `plan` jobs | M2 | Real plan for the seeded cohort is stored and viewable in T2's UI | #6 | T1.2, T1.4, T1.9, T2.9 |
| T1.6 | ~20 benign and trap tasks, plus baselines (no review; per-call approval counts) for the scorecard | M3–M4 | `pnpm eval:scorecard` prints the comparison table | #7 | T1.5, T4.2 |
| T1.7 | _Stretch:_ Slack summary step (`slack.message.postSummary`) | after M3 | Behind the trim decision | #8 | T1.5 |
| T1.8 | _Stretch:_ SurrealDB precedents (explicit promotion, recall with trace) | after M3 | Behind the trim decision | #9 | T1.5 |
| T1.9 | Signed Era tenant tokens in both workers: mint where the operator holds the admin token, pass to planner and executor workers, refresh before the 1-hour expiry | M2 | Tenant isolation and reset tests pass through the workers' config | #39 | T1.1 |

## Decisions

_(add dated entries)_

## Handoff log

_(newest first: date, who, state, open PRs or branches, next step, gotchas)_
