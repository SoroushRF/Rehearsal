# Rehearsal

**Terraform plan for AI agents doing batch operations.** The agent plans in a simulated copy of the company. A reviewer approves the exact plan once, bound to its hash. A deterministic executor with no model then applies that plan to "production". Before each step it re-checks the step's assumptions, holds any that went stale, and records a receipt.

Build North hackathon, Oct 2026. Both worlds are local [Era](https://console.era.eon.io) simulators: this is not a real bank, and nothing here is a compliance claim.

## Layout

| Path | What | Owner |
|---|---|---|
| `packages/contracts` | Zod wire types: plan manifest, actions, approvals, attempts, receipts, replay bundles | joint |
| `packages/core` | RFC 8785 canonical hash, dependency graph and exclusion, policy rules, the five ports | B |
| `packages/providers` | Era world config and Stripe/Zendesk adapters (`ProviderPort`) | A |
| `packages/db` | Drizzle schema for Postgres 17 | B |
| `packages/planner` | Claude tool loop (fixture planner for now) | A |
| `packages/testkit` | Fake clock, shared fixture bundles | D |
| `apps/api` | Fastify API; serves the built web app | C |
| `apps/web` | React + Vite + Tailwind review UI | C |
| `apps/planner-worker` | Model key + planning world only | A |
| `apps/executor-worker` | Operational world only, no model | B |
| `scenarios/billing` | Policy and generated replay bundles | D |
| `infra/compose.yaml` | Postgres + Stripe/Zendesk planning and operational worlds | A/C |
| `ml/` | Python 3.12 LoRA experiment (advisory only) | D |
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

## Rules of the road

- Freeze contract changes as additive. Coordinate any breaking change with every consumer.
- Merge small vertical slices at least daily. `main` stays green.
- Fixture results are labelled `fixture` until they run against real Era images.
- Never commit vendor keys, model weights or downloaded image layers.

Open team decisions are in [docs/decisions/0001-open-team-decisions.md](docs/decisions/0001-open-team-decisions.md). The full spec is in [docs/source/build-plan.md](docs/source/build-plan.md).
