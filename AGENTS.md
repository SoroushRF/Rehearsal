# AGENTS.md

Shared instructions for every person and every coding agent (Claude Code, Codex, Cursor, …) working in this repo.

**Read in this order before doing anything:**
1. `AGENTS.local.md` at the repo root, if it exists. It says who you're working for. It's personal and gitignored.
2. This file.
3. That person's track file in `docs/tracks/` (see [Roster](#roster)).
4. [`docs/plan.md`](docs/plan.md) for milestones M6–M9 and the order of work, and the [blocker board](https://github.com/SoroushRF/Rehearsal/blob/status/BLOCKERS.md) for what blocks what.

If the local file and the roster disagree about someone's track, **the roster wins**.

## The project

Rehearsal is "terraform plan" for AI agents doing batch fintech operations.
1. An agent plans a billing remediation (Stripe refunds, Zendesk ticket updates) inside an Era simulator **planning world**.
2. A reviewer approves the exact plan once. The approval is bound to the plan's canonical hash.
3. A deterministic executor with **no model** applies it to a separate **operational world**. Before each step it re-checks the step's assumptions, holds anything stale, and writes a receipt.

**Status (Nov 2026).** The Build North hackathon is over (tag `submission-2026-10-25`); milestones M1–M5 are historical. Work now follows milestones M6–M9 in [`docs/plan.md`](docs/plan.md), set by decisions [0017](docs/decisions/0017-determinism-replay-and-deferrals.md) to [0020](docs/decisions/0020-external-agents-mcp-and-submission.md). [`docs/handoff-2026-11-03.md`](docs/handoff-2026-11-03.md) lists unfinished work and how to set up a machine (Node 24, Postgres on another port, hosted memory gates). The original spec is [`docs/source/build-plan.md`](docs/source/build-plan.md); its person A/B/C/D split is replaced by the tracks below.

## Non-negotiable rules

These are the product. Breaking one is a bug even if tests pass.

- **Separate credentials.** The planner worker never receives operational-world URLs or the Era admin token. The executor worker never receives a model key. Both workers check this at startup; keep those checks.
- **No model in execution.** Impact-model advice can prioritize or explain. It cannot release a mandatory hold (see [decision 0001](docs/decisions/0001-open-team-decisions.md) for the open "soft signal" question).
- **Approval is for an exact hash.** Apply takes a stored plan reference plus the expected revision and hash. Never accept action bodies from the browser. Any change that affects execution creates a new revision, and the new revision needs a new approval.
- **Journal before dispatch.** Persist the exact request bytes and idempotency key before sending. An unknown outcome is reconciled through reads, never blindly re-sent. A refund or appended note is never "rolled back".
- **Money** is an integer number of minor units plus a currency. No floats.
- **Typed operations only:** `stripe.refund.create`, `zendesk.ticket.patchFields`, `zendesk.ticket.appendPrivateNote`, `zendesk.ticket.appendPublicReply` (exact approved template text), `slack.message.postSummary` (the run summary, always last), `stripe.customer.balanceCredit` (instead of a refund, under a policy with a credit limit). No arbitrary URL, method or JSON-patch tools.
- **Append-only history.** Plans, approvals, attempts and receipts are never edited in place; corrections are new rows.
- **Label your evidence** as `fixture`, `era_integration` or `native_stripe_test`. Results are `fixture` until they have run against real Era images or Stripe test mode. A number without a label and a commit is not a result. Do not round up, and do not drop the caveats listed in the handoff. Never claim something we didn't run.
- **No spending.** Never run anything that calls a paid model, a cloud GPU or a live payment account unless the person in the session says so in that session. Stripe keys must start with `sk_test_`.
- **No ML.** [Decision 0008](docs/decisions/0008-ml-out-of-hackathon-scope.md) stands. Do not propose training a model to make the project look more advanced.
- **Demo props stay out.** The scripted judge planner, `world_resets` and `rehearsal fresh` live in the private repository on purpose. Do not rebuild them here.
- **Never commit** `.env`, keys, tokens, model weights or downloaded image layers.

## Repo map

```text
apps/api              Fastify API, serves built web (T2)
apps/web              React + Vite + Tailwind review UI (T2)
apps/planner-worker   model key + planning world only (T1)
apps/executor-worker  operational world only, no model (T3)
packages/contracts    Zod wire types; shared, additive changes only (all)
packages/core         hash, DAG, policy, ports; executor engine + guards (T3/T4)
packages/providers    Era client; read side (T1), write side (T3)
packages/db           Drizzle schema, migrations, journal (T3)
packages/planner      model tool loop (Gemini on Vertex AI) + planning tools (T1)
packages/memory       precedents on SurrealDB Agent Memory + citation check (T1)
packages/testkit      fake clock, fake provider, fixture bundles (all)
scenarios/billing     policy + generated bundles + Era fixtures (T1/T4)
infra/                compose for Postgres + Era worlds (T1)
ml/                   archived; no ML work (decision 0008)
docs/                 plan, tracks, decisions, source docs
```

## Commands

```bash
pnpm install
pnpm format                                # Biome
pnpm fixtures:write                        # regenerate scenarios/billing/cases from testkit
pnpm infra:up / infra:down                 # Postgres + 4 Era worlds (needs Docker Desktop)
pnpm smoke:era                             # all worlds reachable + writable
pnpm dev                                   # API :3000 + web :5173
pnpm rehearsal up | start | test --all    # one command: worlds, all processes with their own env files, every test
pnpm blockers                              # preview the blocker board from the track tables
```

**Checks before any PR** (CI runs the same):

```bash
pnpm typecheck
pnpm lint
pnpm --filter @rehearsal/web build
DB_TESTS=1 pnpm test
```

On Windows: Biome fixes import order with `npx biome check --write <file>`; a local `.deploy/` folder can break `pnpm lint`; run Python with `python -X utf8`; the mTLS tests need OpenSSL 3, so put `C:\Program Files\Git\usr\bin` first on `PATH`.

## Tracks

Work is split into **feature tracks**, not frontend/backend. Each track owns one demo moment end to end. A track is a unit of work, not a person: people move between tracks and the track file carries the state.

| Track | Demo moment | Main paths | Track file |
|---|---|---|---|
| **T1 Rehearse** | The agent plans in a copy of the company | `infra/`, `scenarios/` data, provider read side, `packages/planner`, `apps/planner-worker`, scorecard | [T1-rehearse.md](docs/tracks/T1-rehearse.md) |
| **T2 Review & Approve** | Uncheck a customer and their note drops; finance must sign; approve once | `apps/web`, API plan/approval routes, Clerk, `core/policy`, deploy | [T2-review-approve.md](docs/tracks/T2-review-approve.md) |
| **T3 Apply** | Exactly the approved plan is applied, through 429s and a lost response, with receipts | `packages/db`, `apps/executor-worker`, executor engine, provider write side, job queue | [T3-apply.md](docs/tracks/T3-apply.md) |
| **T4 Guard** | A new duplicate charge is caught; a teammate's edit survives | guards, own-write tracking, compensation, `scripts/inject` | [T4-guard.md](docs/tracks/T4-guard.md) |

### Roster

| Track | Current owner | Since |
|---|---|---|
| T1 Rehearse | @SoroushRF | 2026-10-20 |
| T2 Review & Approve | @parsaabbasian | 2026-10-22 |
| T3 Apply | @ArtinMe | 2026-10-21 |
| T4 Guard | @skhdemo | 2026-10-21 |
| Integrator of the day | _rotates daily_ | |

**Benchmark tasks** (issues labelled `benchmark`, in any track) are owned by @SoroushRF, whoever owns the track. Their rows stay in their track file under their task ID.

### Switching tracks

1. The outgoing owner adds a dated entry to the track file's **Handoff log**: state, open PRs and branches, next step, gotchas. They push any work in progress as a draft PR.
2. One PR swaps the names in the roster. Both people approve it.
3. The incoming owner reads the track file, its open PRs and its open issues (`gh issue list --label track:T3`).

Never keep task state only in `AGENTS.local.md` or in your head. If it isn't in the track file, an issue or a PR, the next owner can't see it.

## Workflow

**Tasks.** Each task has an ID in its track file (`T3.2`) and a GitHub Issue labelled `track:Tn` (plus `stretch` where it applies) with milestone `M6`–`M9` (or none, when deferred); the track file links it in the Issue column. New tasks get a row in the track file and an issue. Put `Closes #N` in the PR. Each task row has a **Blocked by** column; keep it accurate, because the [blocker board](docs/blockers.md) is generated from it plus live issue and PR status. The track tables are the only source of dependency edges: GitHub's native blocked-by links are not maintained.

**Branches.** Trunk-based with short-lived branches off `main`:

| Prefix | Use |
|---|---|
| `t1/…` `t2/…` `t3/…` `t4/…` | Track work, e.g. `t3/T3.2-executor-loop` |
| `contracts/…` | Changes to `packages/contracts`. Additive only, small, merged first, announced in team chat. |
| `chore/…` | Tooling, CI, docs, workflow |
| `fix/…` | Bug fixes. The only kind allowed after the feature freeze. |

No `develop` branch and no long-lived per-track branches. Rebase on `main` at least daily.

**Pull requests.** Everything lands through a PR; nobody pushes to `main`.
- Small: ideally under ~400 changed lines. Split large work into several PRs.
- Fill in the template: track, task ID or issue, which demo moment it moves, evidence level, how it was tested.
- CI green (typecheck, lint, test, web build). Approval is optional (the author can merge their own PR), but ask for a review when the change is risky. Merge with a regular merge commit; the branch is deleted on merge.
- These changes need a reviewer **from another track**: `packages/contracts`, the plan hash and canonicalization, guards, executor admission, credential handling.
- If you have to touch another track's paths, keep the change minimal and say so in the PR description.

**Integrator of the day.** Keeps `main` green, merges approved PRs promptly, runs the end-to-end demo on `main` each evening and posts the result in team chat.

## Conventions

- TypeScript everywhere. Validate with Zod at every trust boundary (HTTP, jobs, provider responses, model output).
- Tests live in each package's `test/` folder and run with Vitest. Fixtures come from `@rehearsal/testkit`.
- Match the surrounding code's style and comment density. Biome formats.
- Don't add infrastructure the plan rules out (Redis, Kafka, Temporal, LangGraph, a vector or graph DB, extra microservices) without a decision record in `docs/decisions/`.
- New decisions go in `docs/decisions/NNNN-title.md`. They're short: context, decision, consequences.

## Notes for coding agents

- **Stay in the track you were asked to work in.** Each track has a human owner. Never start another track's task, even when it blocks yours. Say what is blocked and stop.
- Stay inside the current track's paths unless the task requires otherwise. Say so in the PR when it does.
- Ask before filing or closing an issue, and before opening a PR. One change per PR, CI green before merge.
- Run the [checks before any PR](#commands).
- Never push to `main` or force-push a shared branch. Merge only through a PR with green CI.
- Era `/_admin` routes (inject, reset, faults) are operator tools. Use them only through `scripts/`, tests, or the API acting as operator for one org's own tenants. That API exception is exactly four modules: `apps/api/src/repair.ts` ([0016](docs/decisions/0016-repair-a-held-run.md)), `apps/api/src/problems.ts` ([0015](docs/decisions/0015-live-demo-incidents.md)), `apps/api/src/org-worlds.ts` and `apps/api/src/rehearsal-operator.ts` ([0013](docs/decisions/0013-execution-rehearsal.md)). Never call them from planner or executor code.
- When a task is done, update the track file's task table, plus the handoff log if anything is left half-finished.
