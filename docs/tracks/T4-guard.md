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

| ID | Task | Milestone | Done when | Issue | Blocked by |
|---|---|---|---|---|---|
| T4.1 | Pure guards: observation projection compare, query-membership diff (added/removed, empty results count), own-write overlay advanced only by confirmed receipts | M1 | Unit tests on fixture observations | #25 | — |
| T4.2 | Injection scripts: phantom charge, teammate field edit, Era faults, reset. Exposed as `pnpm demo:phantom` / `demo:conflict` / `demo:reset`. | M2 | Scripts run against local worlds | #26 | — |
| T4.3 | Wire guards into T3's admission; hold reasons in receipts; dependents skipped | M2–M3 | `phantom` bundle passes on Era. **Done:** `evals/providers/test/phantom.test.ts` | #27 | T4.1, T4.2, T3.2, T1.3, T3.3, T1.9 |
| T4.4 | Conditional compensation on owned fields: re-read, revert only if our value is still there, otherwise record a conflict | M3 | `teammate-conflict` bundle passes on Era | #28 | T4.3, T3.3 |
| T4.5 | ML smoke test: Qwen3.5-0.8B LoRA on 32 cases, weights change, save and reload, peak memory measured (Python 3.12, CUDA 12.7-compatible wheels) | M1 | Smoke log + adapter hash in `ml/manifests/` | #29 | — |
| T4.6 | ML pilot: labels from replay bundles plus perturbations; base vs. tuned vs. rules vs. Claude zero-shot; go/no-go | M2–M3 | Report in `evals/impact/`; decision recorded | #30 | T4.5 |
| T4.7 | _If go:_ impact service behind `ImpactPort` (timeout → abstain), advisory only | M4 | Integration test: model absent or failing → same execution | #31 | T4.6 |

## Decisions

- **2026-10-21.** A missing, incomplete, or mismatched re-check holds the step as `evidence_unavailable`. It is never treated as proof that the approved rows and query membership are unchanged.

## Handoff log

_(newest first: date, who, state, open PRs or branches, next step, gotchas)_

### 2026-10-22, T4.4 part 1

- **Compensation is in, behind a `compensate` hook in the executor** (like `guard`). `createCompensator` in `packages/core/src/compensation.ts` implements it, and the executor worker installs it. The rules are in [decision 0007](../decisions/0007-when-compensation-runs.md).
- **The `teammate-conflict` bundle passes on the fake world** (`apps/executor-worker/test/compensation.test.ts`).
- **The bundle's teammate edit now lands after the failed note**, not after the patch. An edit before the note makes the read guard hold the note, so the case never fails and nothing is compensated.
- **Next.** Part 2: the same bundle on Era (`evals/providers/test/compensation.test.ts`, written and passing locally), then mark T4.4 done.

### 2026-10-22, T4.2 follow-up

- **The demo scripts act on the T1.2 cohort.** `DEMO` in `scripts/inject/session.ts` replaces `SEED`:
  - `demo:phantom` injects `ch_INC0927c01phantom` for c01 (a copy of its CAD duplicate, created 2026-09-25), plus an October control that must stay outside the window.
  - `demo:conflict` edits c02's ticket (`9100002`), the case the `teammate-conflict` bundle uses.
  - `demo:fault` reads c01's first charge.
- **Run `pnpm demo:reset` first.** It seeds the cohort the scripts expect. All four scripts pass on local Era.
- **Next.** T4.4.

### 2026-10-22, T4.3 done on Era

- **`phantom` passes on Era** (`evals/providers/test/phantom.test.ts`, `ERA_CONFORMANCE=1`). Evidence: `era_integration`.
  - It seeds the T1.2 cohort into both worlds and builds the plan from planning-world reads of c01 and c02. Those cases match the fixture plan's amounts and roles.
  - It then injects an in-window duplicate (`ch_INC0927c01phantom`) for c01 into the operational world only.
  - `executeRun` with the real read and write adapters and `createReadGuard` holds `refund_001` (`query_membership_changed`, added the phantom) and skips `note_001`. c02's refund, patch and note apply.
  - The world agrees: there's no refund on any c01 charge and one on c02's duplicate, and the planning world never sees the phantom.
  - With the guard removed, the same test refunds c01, so it really exercises the guard.
- **Next.** T4.2 follow-up: point `SEED` in `scripts/inject/session.ts` at a cohort case, so `demo:phantom` and `demo:conflict` act on the incident. Then T4.4. T3 still has to pass `guard: createReadGuard(...)` when it wires the executor worker.

### 2026-10-22, T4.3 part 2

- **Review follow-ups from #47 are in.**
  - The own-write overlay is keyed by record (`entityKey`), not by observation id.
  - A full refund also expects `refunded: true`.
  - Patch and note receipts credit the ticket's `updated_at` from the write response.
  - The read guard re-reads each record and query once per step.
  - The fake world's query now honours the window and the cutoff when a charge has `created`.
- **Not changed, on purpose:**
  - An adopted refund can't be counted twice today, because a revision keeps its parent's observations (`excludeActions`) and the executor never writes the planning world. A test pins that.
  - Query membership has no own-write overlay. `byCustomerInWindow` can't be moved by our writes; add one before adding a predicate that can.
- **Don't add `updated_at` to a ticket projection without revisiting `creditUpdatedAt`.** Once it's compared, crediting our response's stamp can hide a teammate's edit to a field we don't project (tags, assignee, a public reply). That happens when they write between the guard's re-read and our note (notes carry no `safe_update`), or in the same second as our write (one-second precision, capability matrix §9). Today it's a no-op: `zendeskTicketProjection` is `id`, `priority`, `status` and `requester_id`.
- **Gotcha.** A patch adopted from an earlier revision has no `updated_at` in its receipt. Once T1's ticket projection includes `updated_at`, a later note on that ticket will hold after a re-approval. This fails closed.
- **Still open (#27).** The Era run waits on T1.3 #4 and T3's worker wiring.

### 2026-10-21, T4.3 part 1

- **The guards run inside the executor on the fake provider.** `createReadGuard` in `packages/core/src/step-guard.ts` is the executor's `StepGuard`. Before a step is sent, it re-reads that step's evidence through the operational `ProviderPort`s and calls `guardAction`. The own-write overlay is built from `confirmedReceipts`. The `phantom` bundle passes through `executeRun` (`apps/executor-worker/test/step-guard.test.ts`).
- **Still open (#27).** The task is done when `phantom` passes on Era, which needs T1.3's read adapters, T3.3's write adapters, and T1.9's tenant tokens. Those were added to **Blocked by**.
- **Next.** When T3 wires the executor worker to consume `apply` jobs, pass `guard: createReadGuard({ providers, worlds, clock })` with the same operational providers and worlds as the executor. Then run the phantom scenario on Era with `pnpm demo:phantom`.
- **Gotcha.** A ticket step holds on any change to a planned ticket field, including a note whose own write doesn't touch that field. That is deliberate (a hold, never a false admit). Relax it only with a decision.

### 2026-10-21, T4.2

- **T4.2 runs on local Era.** `pnpm demo:reset`, `demo:phantom`, `demo:conflict` (with an optional `--priority=`), and `demo:fault` are in `scripts/inject/`. Each prints one line per check and exits non-zero on a failure.
- **Gotcha (superseded 2026-10-22, see above).** They targeted the image's seeded customer `cus_necGym2uIJ94j40b` and ticket `4000001` until the T1.2 cohort landed.
- **Gotcha.** Faults are container-wide. `demo:fault` clears them before exiting. Never run `demo:reset` while an executor is applying: reset forgets Stripe idempotency keys.

### 2026-10-21, T4.1

- **T4.1 is done on fixtures.** `guardAction`, `compareObservation`, `diffQueryMembership`, and `advanceOverlay` are in `packages/core/src/guards.ts`. Tests cover the phantom bundle, a missing or incomplete re-check, and an own write that must not false-hold the note after it.
- **Next.** T4.2 injection scripts against the local Era worlds. Wiring the guards into admission (T4.3) waits on the executor loop (#19).
- **Gotcha.** The ML notes assume an RTX 4070 with 8 GB. The current machine has an RTX 5080 with 16 GB and a CUDA 13.3 driver, so pick training wheels to match it.
