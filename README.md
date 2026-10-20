# Rehearsal

**Terraform plan for AI agents doing batch operations.** The agent plans in a simulated copy of the company. A reviewer approves the exact plan once, bound to its hash. A deterministic executor with no model then applies that plan to "production". Before each step it re-checks the step's assumptions, holds any that went stale, and records a receipt.

Build North hackathon, Oct 2026. Both worlds are local [Era](https://console.era.eon.io) simulators: this is not a real bank, and nothing here is a compliance claim.

**Contributing:** start with [AGENTS.md](AGENTS.md), which covers tracks, roster, branching and PR rules, then [docs/plan.md](docs/plan.md). Copy `AGENTS.local.example.md` to `AGENTS.local.md` for your personal notes.

## Layout

| Path | What | Track |
|---|---|---|
| `packages/contracts` | Zod wire types: plan manifest, actions, approvals, attempts, receipts, replay bundles | all |
| `packages/core` | RFC 8785 canonical hash, dependency graph and exclusion, policy rules, the five ports | T2 policy, T3 engine, T4 guards |
| `packages/providers` | Era world config and Stripe/Zendesk adapters (`ProviderPort`) | T1 reads, T3 writes |
| `packages/db` | Drizzle schema for Postgres 17 | T3 |
| `packages/planner` | Claude tool loop (fixture planner for now) | T1 |
| `packages/testkit` | Fake clock, shared fixture bundles | all |
| `apps/api` | Fastify API; serves the built web app | T2 |
| `apps/web` | React + Vite + Tailwind review UI | T2 |
| `apps/planner-worker` | Model key + planning world only | T1 |
| `apps/executor-worker` | Operational world only, no model | T3 |
| `scenarios/billing` | Policy and generated replay bundles | T1, T4 |
| `infra/compose.yaml` | Postgres + Stripe/Zendesk planning and operational worlds | T1 |
| `ml/` | Python 3.12 LoRA experiment (advisory only) | T4 |
| `docs/source/` | Project brief, build plan, Era audit | — |

## Setup

Requires Node 24.11.1, pnpm 11 and Docker Desktop (running).

```bash
pnpm install
cp .env.example .env
pnpm test            # contracts, core, fixtures, API
pnpm infra:up        # Postgres + 4 Era worlds
pnpm smoke:era       # day-one gate step 1: all worlds reachable and writable
pnpm dev             # API :3000 + web :5173
```

The core must always start without memory, model-serving or mobile credentials.

Open team decisions are in [docs/decisions/0001-open-team-decisions.md](docs/decisions/0001-open-team-decisions.md). The full spec is in [docs/source/build-plan.md](docs/source/build-plan.md).
