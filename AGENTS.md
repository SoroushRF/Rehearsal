# AGENTS.md

Shared instructions for every person and every coding agent (Claude Code, Codex, Cursor, …) working in this repo.

**Read in this order before doing anything:**
1. `AGENTS.local.md` at the repo root, if it exists. It says who you're working for. It's personal and gitignored.
2. This file.
3. That person's track file in `docs/tracks/` (see [Roster](#roster)).
4. [`docs/plan.md`](docs/plan.md) for milestones and today's target, and the [blocker board](https://github.com/SoroushRF/Rehearsal/blob/status/BLOCKERS.md) for what blocks what.

If the local file and the roster disagree about someone's track, **the roster wins**.

## The project

Rehearsal is "terraform plan" for AI agents doing batch fintech operations.
1. An agent plans a billing remediation (Stripe refunds, Zendesk ticket updates) inside an Era simulator **planning world**.
2. A reviewer approves the exact plan once. The approval is bound to the plan's canonical hash.
3. A deterministic executor with **no model** applies it to a separate **operational world**. Before each step it re-checks the step's assumptions, holds anything stale, and writes a receipt.

Hackathon: Build North. Submission due **Oct 25, 2026** (we aim for the afternoon). Full spec: [`docs/source/build-plan.md`](docs/source/build-plan.md). Its person A/B/C/D split is replaced by the tracks below.

## Non-negotiable rules

These are the product. Breaking one is a bug even if tests pass.

- **Separate credentials.** The planner worker never receives operational-world URLs or the Era admin token. The executor worker never receives a model key. Both workers check this at startup; keep those checks.
- **No model in execution.** Impact-model advice can prioritize or explain. It cannot release a mandatory hold (see [decision 0001](docs/decisions/0001-open-team-decisions.md) for the open "soft signal" question).
- **Approval is for an exact hash.** Apply takes a stored plan reference plus the expected revision and hash. Never accept action bodies from the browser. Any change that affects execution creates a new revision, and the new revision needs a new approval.
- **Journal before dispatch.** Persist the exact request bytes and idempotency key before sending. An unknown outcome is reconciled through reads, never blindly re-sent. A refund or appended note is never "rolled back".
- **Money** is an integer number of minor units plus a currency. No floats.
- **Typed operations only:** `stripe.refund.create`, `zendesk.ticket.patchFields`, `zendesk.ticket.appendPrivateNote`. `stripe.customer.balanceCredit`, `slack.message.postSummary` and `zendesk.ticket.appendPublicReply` are defined in contracts but can't be planned until T1.14, T1.7 and T1.13 add them to `Action`. No arbitrary URL, method or JSON-patch tools.
- **Append-only history.** Plans, approvals, attempts and receipts are never edited in place; corrections are new rows.
- **Label your evidence.** Results are `fixture` until they have run against real Era images. Never claim something we didn't run.
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
packages/planner      Claude tool loop + planning tools (T1)
packages/memory       precedents on SurrealDB Agent Memory + citation check (T1)
packages/testkit      fake clock, fake provider, fixture bundles (all)
scenarios/billing     policy + generated bundles + Era fixtures (T1/T4)
infra/                compose for Postgres + Era worlds (T1)
ml/                   Python 3.12 LoRA experiment (T4 / GPU machine)
docs/                 plan, tracks, decisions, source docs
```

## Commands

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test   # run all three before opening a PR
pnpm format                                # Biome
pnpm fixtures:write                        # regenerate scenarios/billing/cases from testkit
pnpm infra:up / infra:down                 # Postgres + 4 Era worlds (needs Docker Desktop)
pnpm smoke:era                             # all worlds reachable + writable
pnpm dev                                   # API :3000 + web :5173
pnpm rehearsal up | start | test --all    # one command: worlds, all processes with their own env files, every test
```

## Tracks

Work is split into **feature tracks**, not frontend/backend. Each track owns one demo moment end to end. A track is a unit of work, not a person: people move between tracks and the track file carries the state.

| Track | Demo moment | Main paths | Track file |
|---|---|---|---|
| **T1 Rehearse** | The agent plans in a copy of the company | `infra/`, `scenarios/` data, provider read side, `packages/planner`, `apps/planner-worker`, scorecard | [T1-rehearse.md](docs/tracks/T1-rehearse.md) |
| **T2 Review & Approve** | Uncheck a customer and their note drops; finance must sign; approve once | `apps/web`, API plan/approval routes, Clerk, `core/policy`, deploy, video | [T2-review-approve.md](docs/tracks/T2-review-approve.md) |
| **T3 Apply** | Exactly the approved plan is applied, through 429s and a lost response, with receipts | `packages/db`, `apps/executor-worker`, executor engine, provider write side, job queue | [T3-apply.md](docs/tracks/T3-apply.md) |
| **T4 Guard** | A new duplicate charge is caught; a teammate's edit survives | guards, own-write tracking, compensation, `scripts/inject`, `ml/` | [T4-guard.md](docs/tracks/T4-guard.md) |

### Roster

| Track | Current owner | Since |
|---|---|---|
| T1 Rehearse | @SoroushRF | 2026-10-20 |
| T2 Review & Approve | @parsaabbasian | 2026-10-22 |
| T3 Apply | @ArtinMe | 2026-10-21 |
| T4 Guard | @skhdemo | 2026-10-21 |
| Integrator of the day | _rotates daily_ | |

**Benchmark tasks** (issues labelled `benchmark`, in any track) are owned by @SoroushRF, whoever owns the track. Their rows stay in their track file under their task ID.

**ML runs on the GPU machine** (RTX 5080, 16 GB). Whoever has that machine runs training, whatever their track.

### Switching tracks

1. The outgoing owner adds a dated entry to the track file's **Handoff log**: state, open PRs and branches, next step, gotchas. They push any work in progress as a draft PR.
2. One PR swaps the names in the roster. Both people approve it.
3. The incoming owner reads the track file, its open PRs and its open issues (`gh issue list --label track:T3`).

Never keep task state only in `AGENTS.local.md` or in your head. If it isn't in the track file, an issue or a PR, the next owner can't see it.

## Workflow

**Tasks.** Each task has an ID in its track file (`T3.2`) and a GitHub Issue labelled `track:Tn` (plus `stretch` where it applies) with milestone `Mn`; the track file links it in the Issue column. New tasks get a row in the track file and an issue. Put `Closes #N` in the PR. Each task row has a **Blocked by** column; keep it accurate, because the [blocker board](docs/blockers.md) is generated from it plus live issue and PR status.

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

- TypeScript everywhere except `ml/`. Validate with Zod at every trust boundary (HTTP, jobs, provider responses, model output).
- Tests live in each package's `test/` folder and run with Vitest. Fixtures come from `@rehearsal/testkit`.
- Match the surrounding code's style and comment density. Biome formats.
- Don't add infrastructure the plan rules out (Redis, Kafka, Temporal, LangGraph, a vector or graph DB, extra microservices) without a decision record in `docs/decisions/`.
- New decisions go in `docs/decisions/NNNN-title.md`. They're short: context, decision, consequences.

## Notes for coding agents

- Stay inside the current track's paths unless the task requires otherwise. Say so in the PR when it does.
- Run `pnpm typecheck && pnpm lint && pnpm test` before proposing a PR.
- Never push to `main` or force-push a shared branch. Merge only through a PR with green CI.
- Era `/_admin` routes (inject, reset, faults) are operator tools. Use them only through `scripts/` or tests, never from planner code.
- When a task is done, update the track file's task table, plus the handoff log if anything is left half-finished.
