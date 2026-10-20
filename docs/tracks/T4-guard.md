# T4 Guard: catch what changed, preserve what others did

**Owner:** see the [roster](../../AGENTS.md#roster). The ML tasks run on the GPU machine.

**Demo moments:**
- **Phantom:** after approval, a new duplicate charge appears for a customer. Re-running that customer's query catches it, and the refund and its note are held.
- **Teammate conflict:** a teammate changes a ticket's priority mid-apply, then a later step fails. The undo sees the teammate's value and preserves it, recording a conflict.

**Owns:**
- Guard functions in `packages/core`: observation re-check, query-membership diff, own-write tracking
- Compensation logic
- `scripts/inject/` and the `demo:*` scripts
- `ml/`, the impact model behind `ImpactPort`

**Provides to others:**
- Pure guard functions that T3 calls at admission.
- Injection scripts for T1's traps and T2's demo.

## Acceptance

- **Phantom:** the `phantom` bundle passes on Era. A control case, where the injected charge doesn't match, still applies.
- **Conflict:** the `teammate-conflict` bundle passes on Era. The teammate's value survives and a `compensation_conflict` receipt is recorded.
- **Own writes:** a later step after our own refund or patch doesn't trip a false stale hold.
- **No false proof of absence:** a failed query, a partial query or an unknown pagination state holds the step.
- **Model never gates:** if the impact model is missing, malformed or times out, execution permission doesn't change.

## Tasks

| ID | Task | Milestone | Done when | Issue |
|---|---|---|---|---|
| T4.1 | Pure guards: observation projection compare, query-membership diff (added/removed, empty results count), own-write overlay advanced only by confirmed receipts | M1 | Unit tests on fixture observations | |
| T4.2 | Injection scripts: phantom charge, teammate field edit, Era faults, reset. Exposed as `pnpm demo:phantom` / `demo:conflict` / `demo:reset`. | M2 | Scripts run against local worlds | |
| T4.3 | Wire guards into T3's admission; hold reasons in receipts; dependents skipped | M2–M3 | `phantom` bundle passes on Era | |
| T4.4 | Conditional compensation on owned fields: re-read, revert only if our value is still there, otherwise record a conflict | M3 | `teammate-conflict` bundle passes on Era | |
| T4.5 | ML smoke test: Qwen3.5-0.8B LoRA on 32 cases, weights change, save and reload, peak memory measured (Python 3.12, CUDA 12.7-compatible wheels) | M1 | Smoke log + adapter hash in `ml/manifests/` | |
| T4.6 | ML pilot: labels from replay bundles plus perturbations; base vs. tuned vs. rules vs. Claude zero-shot; go/no-go | M2–M3 | Report in `evals/impact/`; decision recorded | |
| T4.7 | _If go:_ impact service behind `ImpactPort` (timeout → abstain), advisory only | M4 | Integration test: model absent or failing → same execution | |

## Decisions

_(add dated entries)_

## Handoff log

_(newest first: date, who, state, open PRs or branches, next step, gotchas)_
