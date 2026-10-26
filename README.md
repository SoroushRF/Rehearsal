# Rehearsal

Rehearsal is a way to let an AI agent prepare a batch of money and support changes without letting the model touch the live systems.

The agent investigates a copy of the company and writes a plan: refunds, credits, ticket updates, notes, a public reply, and a Slack summary. A person reviews that plan as one job, drops anything they don't want, and approves it once. The approval is bound to a hash of the exact plan. A separate program, with no model in it, then applies that plan to a second copy of the company. Before each step it re-checks the facts the step relied on. If the world has moved, that step is held. Every step ends in a receipt.

Both copies are [Era](https://console.era.eon.io) simulators of Stripe, Zendesk, and Slack. Rehearsal is not a bank, and it does not move live money.

[Open the app](https://rehearsal-api-40b8.onrender.com/app) · [Watch a recorded run](https://rehearsal-api-40b8.onrender.com/?replay=phantom) · [Devpost](https://devpost.com/software/rehearsal-gq5m13)

## The problem

An agent that writes to billing and support systems fails in ways nobody reviews until the job is already done. Approving every tool call stops a person dozens of times and never shows them the whole job. Cleaning up afterwards cannot unsend a ticket reply, and restoring a snapshot can wipe a teammate's edit.

Rehearsal splits deciding from doing. The model may decide. It decides inside a copy. Production, here a second simulator, only ever receives the plan a person approved.

## What a run looks like

A signed-in team sees their company: Stripe charges and balances, Zendesk tickets, Slack messages. They can seed a problem, for example a few customers charged twice, and then file an incident: a kind, a title, a description, and a date window.

**Rehearse.** The planner works only in the planning world. It reads charges, customers, and tickets, and proposes a remedy for the customers who actually match the incident. Look-alikes are left out: a different invoice, another currency, a charge outside the window. The result is a stored plan, grouped by customer. Each step carries the money, whether it can be undone, how the write is protected, and the reads it depends on.

**Review.** Unchecking a customer removes that customer's steps, including a note that depended on their refund. That edit is a new revision with a new hash, and an approval of the previous revision no longer counts. Refunds over the policy threshold need a finance lead. Where the policy asks for two seats, two different people sign. The browser never sends the action bodies. Apply takes the stored plan, the revision, and the expected hash.

**Apply.** The executor walks the approved graph. A new duplicate charge that appeared after approval, and that matches the step's original query, is held, and so is the note that depended on that refund. Other customers still go through. A throttled call is retried with the same request and lands once. A response that never comes back is settled by reading the world, not by sending the refund again. If a later step fails, the executor restores a ticket field only when that field still holds the value this run wrote. A teammate's edit in between is left alone and recorded as a conflict.

**Afterwards.** The company view marks what the run changed: a refunded charge, a credited balance, a ticket, the Slack summary. Each mark links to the run.

An incident the tools cannot handle comes back as an empty plan with a reason. That is a result, not an error. Today the planner can work a duplicate-charge incident and a support backlog. A service outage has no typed remedy yet.

The same approved plan can also be run first in a disposable world, so the team can read a report before anything is sent to the operational world. That report does not approve anything.

## How the system is split

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

The API is the operator. It holds the Era admin token and can reset or seed a world. The workers cannot.

The planner worker is given a model key and the planning world. At startup it refuses to boot if it can see an operational URL, the Era admin token, or an IAM client certificate. The executor worker is given the operational world and no model key. It refuses to boot if a model key is present. Each worker proves itself to the API with its own secret. The API then mints a short-lived token for that worker's own world. The role decides the world. A planner token is never an operational token.

Jobs move on pg-boss. The planner has no database. When someone rehearses a stored incident, the API puts the incident into the job: kind, title, description, window, and the customers the server found in that window. The person's description is carried as their own words, fenced off from the instructions. It cannot add a tool or widen a refund.

## The plan is a document, not a transcript

The model does not get a general HTTP tool. It can only call planning tools that append one of six action kinds:

| Kind | What it is |
|---|---|
| `stripe.refund.create` | Refund a charge, in minor units |
| `stripe.customer.balanceCredit` | Credit the customer's balance instead, under a policy limit |
| `zendesk.ticket.patchFields` | Set priority or status. The previous values are stored for a later undo |
| `zendesk.ticket.appendPrivateNote` | A private note from an approved template |
| `zendesk.ticket.appendPublicReply` | The exact reply text the reviewer approved |
| `slack.message.postSummary` | One summary of the run, always last |

Each action names its customer, the obligation it remedies, the steps it depends on, the role required to approve it, and the observations and queries that must still be true at apply time. A note that mentions a refund depends on that refund. The refund's id in the planning world is not the id the operational world will create, so the note refers to the earlier step. The executor fills in the id the operational world actually returned.

Reads are stored with the query that produced them and a fingerprint of what came back. Writes are stored as a before and an after. Those records are the evidence on the plan.

Policy runs on the plan, not in the model. It decides thresholds, when a credit is allowed instead of a refund, when one remedy per obligation is enough, and when two approvers are required. The plan's canonical form is RFC 8785 JSON. The hash is of that form. Any edit that would change what gets executed creates a new revision, and the new revision needs a new approval.

Contracts between the API, the workers, and the web app are Zod types in `packages/contracts`. Money is never a float.

## Apply is a replay

The executor loads the stored plan and checks the revision and the hash it was given. It does not accept a plan body from the request.

Before a step is sent, the attempt is journaled: the exact request bytes and the idempotency key. Postgres is append-only. Plans, approvals, attempts, and receipts are not edited in place. A correction is a new row.

Admission then re-checks the grant, the hash, the world, and any precedent the plan cited. The guard re-runs the observations and the query:

- A row that was approved and has since changed is stale, and the step is held.
- A new row that now matches the query is a phantom. The step is held, and so is anything that depended on it. A failed or partial query is held too. An empty or broken read is not treated as proof that nothing changed.
- A second remedy for the same obligation is refused, including one that arrived under another plan.

The provider call uses the journaled request. A 429 is retried with that same request. If the response is lost, the executor reads Stripe or Zendesk for the effect and confirms the step if it finds it. It does not send the call again. A refund and an appended note are never "rolled back." The only undo is conditional: for a ticket field this run changed, re-read it, and revert only if the value is still ours. Otherwise record a `compensation_conflict` and leave the teammate's value.

The Slack summary runs after the other steps have settled, held or not, and counts what actually happened.

## Identity and permissions

Clerk signs the person in and stores their organization and one role: owner, finance lead, support lead, or member. A person belongs to one organization. Clerk is not where Rehearsal permissions live. An unmapped Clerk role has none.

The API and the executor ask a separate IAM service over mutual TLS, each with its own client certificate. The browser and the planner have no certificate, so they cannot ask. IAM checks the Clerk session, reads the organization and the role, and maps the role through a versioned rule file onto permissions such as `rehearsal:approve:finance_step`, `rehearsal:apply:plan`, and `rehearsal:invite:member`. The caller cannot send the rule text.

The screen shows the actions the current permissions allow. The server asks IAM again on every command. A grant records the permissions that were true at approval time, and the rule version. Apply checks those stored grants again before anything is sent, without a second trip to Clerk. If IAM is down, the token is bad, or the rule is unknown, the action is refused.

## Precedents

A finance lead can promote a decision from a completed run, for example that an account in collections gets a credit rather than a refund. The statement is published to SurrealDB Agent Memory, in a scope that belongs to one organization, and only becomes active after the API has read it back. Postgres keeps the event log.

Later plans can cite that precedent. The executor does not ask memory whether a step is allowed. It checks the citation against the approved registry. A superseded, withdrawn, or changed precedent holds the step. Memory is the index. The approval is still the authority.

## Repository

| Path | What it is |
|---|---|
| `apps/web` | React, Vite, and Tailwind. The company, the incident, the review, and the run. |
| `apps/api` | Fastify. Plans, approvals, incidents, company reads, and the job enqueue. Serves the built web app. |
| `apps/planner-worker` | The model tool loop. Planning world only. |
| `apps/executor-worker` | The apply loop. Operational world only. No model. |
| `apps/iam` | The permission service. Clerk in, allow or deny out. |
| `packages/contracts` | Zod wire types. Changes are additive. |
| `packages/core` | Hash, dependency graph, policy, guards, and the executor engine. |
| `packages/providers` | Era client. Reads for the planner, writes for the executor. |
| `packages/db` | Drizzle schema, migrations, and the journal. Postgres 17. |
| `packages/planner` | The tool loop and the incident brief. |
| `packages/memory` | Precedent publish and citation checks. |
| `packages/testkit` | Fake clock, fake provider, fixture bundles. |
| `scenarios/` | Billing policy, incident presets, and the IAM rule file. |
| `infra/` | Compose for Postgres and the Era worlds. |
| `evals/scorecard` | The comparison against direct writes and per-call approval, on pinned Era images. |

## Run it locally

Node 24.11, pnpm 11, and Docker.

```bash
pnpm install
cp .env.example .env
pnpm infra:up          # Postgres and the Era worlds
pnpm smoke:era         # worlds reachable and writable
pnpm dev               # API on :3000, web on :5173
```

`pnpm demo:reset` restores the demo company. `pnpm demo:phantom`, run after approval and before apply, plants a new duplicate charge so the guard has something to hold. `pnpm test` runs the suite. Tests that talk to real Era images are opt-in and labelled `era_integration`. Everything else is a fixture.

The comparison of direct writes, modelled per-call approval, and Rehearsal is in [`evals/scorecard/results/latest.txt`](evals/scorecard/results/latest.txt). It was run on 2026-10-25 against pinned Era images with a scripted planner. The per-call reviewer in that file is modelled, not a person.

How to work in the repo is [AGENTS.md](AGENTS.md).
