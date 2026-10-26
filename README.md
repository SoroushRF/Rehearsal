<div align="center">

# Rehearsal

### Terraform plan for AI agents.

An agent plans a batch of refunds and support updates inside a copy of the company. A person approves that exact plan once. A program with no model applies it, and holds any step the world no longer matches.

[Try it live](https://rehearsal-api-40b8.onrender.com/app) · [Watch a recorded run](https://rehearsal-api-40b8.onrender.com/?replay=phantom) · [Devpost](https://devpost.com/software/rehearsal-gq5m13)

[![Build North](https://img.shields.io/badge/Build_North-2026-c5f13a?style=flat-square&labelColor=111111)](https://devpost.com/software/rehearsal-gq5m13)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-149ECA?style=flat-square&logo=react&logoColor=white)](https://react.dev/)
[![Postgres](https://img.shields.io/badge/Postgres-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Clerk](https://img.shields.io/badge/Clerk-6C47FF?style=flat-square&logo=clerk&logoColor=white)](https://clerk.com/)
[![Era](https://img.shields.io/badge/Era-111111?style=flat-square)](https://console.era.eon.io)

</div>

Both copies of the company are [Era](https://console.era.eon.io) simulators of Stripe, Zendesk, and Slack. Rehearsal does not move live money.

## Inspiration

Agents that write to billing and support fail in ways nobody reviews until the job is already done. Approving every tool call stops a person dozens of times and never shows them the whole job. Cleaning up afterwards cannot unsend a ticket reply, and restoring a snapshot can wipe a teammate's edit.

Teams already feel this. In Georgian's Wave 3 benchmark, 55% of technical decision makers reported an AI incident in the last 12 months. 75% use human approval gates, and only 29% use policy-as-code. The threat they name first is excessive agency.

We wanted the opposite shape. The agent may decide. It decides inside a copy. A person approves the whole plan once, and production only ever receives that plan, applied by an engine with no model in it.

## What it does

A billing bug double-charges a set of customers. Finance and support fix it in one place.

1. **Rehearse.** The agent reads Stripe and Zendesk in a planning world and proposes the whole remedy: refunds, credits, ticket updates, notes, a public reply, and one Slack summary. Amounts are exact. Each step says whether it can be undone, how the write is protected, and which read it depends on. The plan is grouped by customer.
2. **Review.** Unchecking a customer drops the note that depended on that refund. That edit is a new revision, so the old approval no longer counts. Refunds over the policy threshold need a finance lead. Where the policy asks for two seats, two different people sign.
3. **Apply.** A separate program, with no model, sends the approved steps to a second world that started from the same company. Before each step it re-reads what that step relied on. A new matching charge, or a row that changed, is held, and so is anything that depended on it. The rest of the plan goes through. Every step ends in a receipt.

The same loop covers the cases that make a batch job hard:

- A refund created in the copy is a different Stripe object from the one created later. Later steps use the id the operational world actually returned.
- A throttled call is retried with the same request and lands once.
- A response that never comes back is settled by reading the world, not by sending the refund again.
- If a later step fails, a ticket field is restored only when it still holds the value this run wrote. A teammate's edit is left in place and recorded as a conflict.
- A second remedy for the same charge is refused.
- A finance lead can promote a decision, such as "this account gets a credit, not a refund." Later plans cite it. If that precedent changes, the old approval no longer covers the step.
- The same plan can be run in a disposable world first. That report does not approve anything.

An incident the tools cannot handle comes back as an empty plan with a reason. Today that covers a duplicate-charge incident and a support backlog. A service outage has no typed remedy yet.

## How we built it

```text
browser
  │
  ▼
API  ──── Postgres (plans, grants, journal, receipts)
  │
  ├── planner worker ── planning world only, model key
  ├── executor worker ─ operational world only, no model
  └── IAM ───────────── Clerk session in, permission decision out
```

**Two worlds.** Planning and operational Era worlds are seeded with the same company and reset to the same instant. Stripe, Zendesk, and Slack are write-enabled. The API holds the Era admin token and can reset or seed a world. The workers cannot. Each worker proves itself with its own secret, and the API mints a short-lived token for that worker's world only. The planner refuses to start if it can see an operational URL, the admin token, or an IAM certificate. The executor refuses to start if a model key is present.

**The planner.** A bounded tool loop. The model cannot call an arbitrary URL. It can only append one of six action kinds: `stripe.refund.create`, `stripe.customer.balanceCredit`, `zendesk.ticket.patchFields`, `zendesk.ticket.appendPrivateNote`, `zendesk.ticket.appendPublicReply`, and `slack.message.postSummary` (always last). Each read is stored with the query and a fingerprint of what came back. Each write is stored as a before and an after. Money is an integer number of minor units. The person's incident text is fenced off from the instructions, so it cannot add a tool or widen a refund.

**The plan.** Dependencies are explicit: a note that mentions a refund depends on that refund, and refers to the earlier step rather than a planning-world id. Policy runs on the plan, not in the model: thresholds, when a credit is allowed instead of a refund, one remedy per obligation, and when two approvers are required. The canonical form is RFC 8785 JSON. The approval is a hash of that form. The browser never sends the action bodies. Apply takes the stored plan, the revision, and the expected hash.

**The executor.** Postgres is append-only. The exact request bytes and the idempotency key are journaled before anything is sent. pg-boss delivers the job to a worker whose environment has the operational world and nothing else. Admission re-checks the grant, the hash, the world, and any cited precedent, then re-runs the observation and the query. A changed row is stale. A new row that now matches the query is a phantom. A failed or empty read is not treated as proof that nothing changed. A 429 retries the journaled request. A lost response is confirmed by reading Stripe or Zendesk. A refund and an appended note are never rolled back.

**Identity.** Clerk signs the person in and stores their organization and one role: owner, finance lead, support lead, or member. Clerk is not where permissions live. The API and the executor ask a separate IAM service over mutual TLS. IAM verifies the Clerk session and maps the role through a versioned rule file onto permissions such as `rehearsal:approve:finance_step` and `rehearsal:apply:plan`. The grant records the permissions that were true at approval time. If IAM is down, the action is refused.

**Precedents.** A promoted decision is published to SurrealDB Agent Memory, in a scope that belongs to one organization, and becomes active only after the API has read it back. Postgres keeps the event log. At apply time the executor does not ask memory whether a step is allowed. It checks the citation against the approved registry.

Contracts between the API, the workers, and the web app are Zod types. The web app is Vite, React, and Tailwind. Tests run on Vitest, including real Postgres and pinned Era images.

| Path | What it is |
|---|---|
| `apps/web` | The company, the incident, the review, and the run |
| `apps/api` | Fastify. Plans, approvals, and the job enqueue |
| `apps/planner-worker` | The model tool loop. Planning world only |
| `apps/executor-worker` | The apply loop. No model |
| `apps/iam` | Clerk session in, allow or deny out |
| `packages/core` | Hash, dependency graph, policy, guards, executor |
| `packages/contracts` | Zod wire types |
| `packages/db` | Drizzle schema and the journal. Postgres 17 |
| `scenarios/` | Billing policy, incident presets, IAM rules |
| `evals/scorecard` | Direct writes vs per-call approval vs Rehearsal |

## Challenges we ran into

The rehearsal and the operational world do not share ids. A note still has to name the refund that production created. Steps refer to earlier results symbolically, and the executor fills in the id that came back.

A lost response is not a failed send. The refund may have happened. Retrying it would apply the remedy twice. The journal already holds the exact request, so a restart reads the world, finds the effect, and confirms the step once.

A hash cannot see a charge that did not exist at approval time. Re-running the original query at admission catches that new row, and the dependent note is held with it.

Undo has to know what it owns. Restoring a ticket field is wrong if a teammate changed that field after we wrote it. The engine re-reads, reverts only its own value, and records a conflict when the value is no longer ours.

Who may click is not the same as who Clerk says they are. Organization role is identity. Permission to approve a finance step or apply a plan is a rule we version and evaluate in IAM.

## Accomplishments that we're proud of

The loop runs on pinned Era images. An agent plans a billing remedy, a reviewer approves it, and the executor applies it.

On the same 28 tasks, with a scripted planner, Rehearsal confirmed 27. Direct writes confirmed 14. Modelled per-call approval confirmed 19. Rehearsal recorded no invalid allows and no duplicates, with 51 approvals against 627 modelled per-call prompts. The per-call reviewer in that comparison is modelled, not a person. The run is [`evals/scorecard/results/latest.txt`](evals/scorecard/results/latest.txt), from 2026-10-25.

The moments we built the product for pass on those simulators: a phantom charge held after approval, a teammate's edit preserved, a throttled refund applied once, and a lost response reconciled instead of repeated.

Around that loop: the review app, hash-bound grants, two-person approval where policy asks for it, precedents a finance lead can promote, a disposable-world rehearsal that approves nothing, and an IAM service the API and the executor call over mutual TLS.

The recorded run linked above is a fixture replay of the executor on a fake provider. The banner on that page says so.

## What we learned

An approval is a fact about one exact plan. Bind it to a hash, store who held which permission, and make the applier re-read the world before it sends anything.

The useful unit of review is the job, not the call. A person can see eight customers, drop one, and watch the dependent note disappear. They cannot do that across dozens of yes-or-no prompts.

A step is only as safe as the query that selected it. Re-checking the row you already saw is not enough. The dangerous record is the one that showed up later.

Once the plan is approved, production should be a replay with receipts, not another conversation.

## What's next for Rehearsal

The next plans should arrive already shaped by the precedents this team has promoted, so a decision on Monday is cited and visible on Friday's diff.

The same approved plan should keep opening as an audit: the policy it was signed under, the hash, the people who signed, and a receipt for every step, including the ones that were held.

From there, more of the company's systems join the same graph, and operators run the loop on their own incidents.

## Built with

TypeScript, React, Vite, Tailwind, Fastify, Zod, Postgres, Drizzle, pg-boss, Clerk, Era, Anthropic, SurrealDB Agent Memory, Vitest, Playwright, Biome.

## Run it locally

Node 24.11, pnpm 11, and Docker.

```bash
pnpm install
cp .env.example .env
pnpm infra:up          # Postgres and the Era worlds
pnpm smoke:era         # worlds reachable and writable
pnpm dev               # API on :3000, web on :5173
```

`pnpm demo:reset` restores the demo company. `pnpm demo:phantom`, run after approval and before apply, plants a new duplicate charge so the guard has something to hold. `pnpm test` runs the suite. Tests that talk to real Era images are opt-in and labelled `era_integration`.

How to work in the repo is [AGENTS.md](AGENTS.md).
