# Rehearsal

**Terraform plan for AI agents doing batch operations.**

An agent plans a batch job in a simulated copy of the company. A person approves that exact plan once, bound to its hash. An executor with no model applies it, and holds any step that went stale.

Build North, October 2026. Both worlds are [Era](https://console.era.eon.io) simulators of Stripe, Zendesk, and Slack. This is not a bank, and nothing here is a compliance claim.

[Try it live](https://rehearsal-api-40b8.onrender.com/app) · [Watch a recorded run](https://rehearsal-api-40b8.onrender.com/?replay=phantom) · [Devpost](https://devpost.com/software/rehearsal-gq5m13)

The recorded run is a **fixture**: the real executor on test data, not a live Era image. The page says so.

## How it works

Five steps. The first two happen in a planning world. Approve is the gate. The last two happen in a separate operational world.

1. **Copy.** The planner reads a copy of the company. It never receives operational URLs or the admin token.
2. **Plan.** It can only propose typed steps: a refund, a balance credit, a ticket update, a private note, a public reply, or the run summary in Slack. Money is an integer number of minor units plus a currency.
3. **Approve.** A person approves one canonical hash. Any change is a new revision and needs a new approval. Where the policy asks for two seats, two different people sign.
4. **Apply.** The executor holds no model key. It saves the exact request before sending, re-checks each step, and holds anything stale. The rest of the plan still runs.
5. **Receipts.** Every step records the plan hash, who approved it, the outcome, and the reason.

## What the guards catch

- A new matching charge after approval is held, and so is the note that depended on it.
- A teammate's edit is left in place. A field is restored only when it still holds the value this run wrote.
- A throttled refund is retried with the same request and lands once.
- A response that never comes back is reconciled by reading, not by sending the refund again.

## Measured

Scripted planner (`scorecard-agent.v2`), pinned Era images, 2026-10-25. Evidence label: `era_integration`. The per-call reviewer is modelled, not a person. Source: [`evals/scorecard/results/latest.txt`](evals/scorecard/results/latest.txt).

| | Direct writes | Per-call approval | Rehearsal |
|---|---:|---:|---:|
| Confirmed | 14/28 | 19/28 | 27/28 |
| Invalid allows | 26 | 14 | 0 |
| Duplicates | 5 | 3 | 0 |
| Reviewer actions | 0 | 627 | 51 |

The miss is an obligation the plan never proposed. Every mode fails that one. Rehearsal re-reads before it writes, so it is slower and makes more simulator calls. Caveats: [`docs/submission.md`](docs/submission.md).

## Limits

- Simulators only. No live money, and no real Zendesk or Slack account. One Stripe **test-mode** refund was run (`native_stripe_test`, [`docs/evidence/native-stripe-recovery.json`](docs/evidence/native-stripe-recovery.json)). Zendesk in that run was an in-memory stand-in.
- A filed incident can be a duplicate charge or a support backlog. There is no remedy yet for a service outage, and an incident the tools cannot handle comes back as an empty plan with a reason.
- Example plans and saved replays stay **fixtures** until a run is labelled as Era.
- The isolation gate on 2026-10-25 (`ca95d7a`) passed 20 of 21 operator checks. A rehearsal worker pointed at a shared world is not refused ([#323](https://github.com/SoroushRF/Rehearsal/issues/323)).
- No model was trained or served for this submission.

## Stack

TypeScript, React, Vite, Tailwind, Fastify, Zod, Postgres, Drizzle, pg-boss, Clerk, and an IAM service over mutual TLS. Tests are Vitest and Playwright. Planning can call a model. Execution cannot. A promoted precedent can be published to SurrealDB Agent Memory.

## Team

| | |
|---|---|
| Soroush ([@SoroushRF](https://github.com/SoroushRF)) | The agent plans in the copy |
| Parsa ([@parsaabbasian](https://github.com/parsaabbasian)) | Review, approval, the app |
| Artin ([@ArtinMe](https://github.com/ArtinMe)) | The executor and the receipts |
| Sepehr ([@skhdemo](https://github.com/skhdemo)) | The guards, and this front door |

## Run it locally

Node 24.11, pnpm 11, and Docker.

```bash
pnpm install
cp .env.example .env
pnpm test
pnpm infra:up        # Postgres and the Era worlds
pnpm smoke:era       # worlds reachable and writable
pnpm dev             # API :3000, web :5173
```

`pnpm demo:reset` restores the demo data. `pnpm demo:phantom` plants a new duplicate charge after approval, which is the hold in the demo.

Contributing starts at [AGENTS.md](AGENTS.md). The submission kit, including what not to claim, is [docs/submission.md](docs/submission.md).
