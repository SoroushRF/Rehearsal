# 0013: Execution rehearsal and its trust boundaries (T1.20)

**Status:** proposed 2026-10-24 (Soroush, T1). Needs a T3 reviewer (admission, journal, a new worker role) and a T4 reviewer (isolation and challenges) before T1.23 or T3.14 add runtime paths.

## Context

The [beyond backlog](../beyond.md) adds an **execution rehearsal**: run an exact stored plan in disposable Era worlds, apply allowlisted challenges (T4.11), read the effects independently (T4.12) and show a report before anyone approves it for the operational world. This is not the incident-to-plan "rehearse" flow (the planner in the planning world). That flow stays as it is.

Five facts from the code and the [capability matrix](../capability-matrix.md) shape this record:

1. **Faults are container-wide.** That's why compose already runs one container per world. A challenge that injects 429s or a lost response in a container affects every tenant in it.
2. **Every container shares one admin token** (`SIMCORE_ADMIN_TOKEN: ${ERA_ADMIN_TOKEN}`). Whoever holds it can mint any tenant's token on any world, and can reset, inject or fault any of them.
3. **Era mints the same IDs in every tenant and world.** `re_TOm3JH6PbIhGMHd0` was the first refund everywhere (matrix surprise 5).
4. **Operation keys don't depend on the world.** `operationKey(orgId, planId, action)` is the same for a rehearsal and an operational run of the same plan. A rehearsal journal row with that key, seen by the operational executor, would read as "applied by an earlier attempt; not re-sent". The real refund would then never go out.
5. **Tenant data isolation is tested; network isolation is not.** `tenancy.test.ts` shows tenant A's refund and ticket edit are invisible in tenant B with signed tokens. A request with no signed token lands in tenant `default`, and locally every container is reachable on 127.0.0.1.

## Decision

### 1. What a rehearsal is bound to

A rehearsal report is an immutable row that names:

| Binding | Value |
|---|---|
| Plan | `orgId`, `planId`, `revision`, `planHash`, exactly as stored. The rehearsal loads the stored manifest; it never takes actions from the browser or a job. |
| Snapshot | `snapshot.kind = "plan-evidence"`, `snapshot.digest` = fingerprint of the plan's own observations and query evidence |
| Scenario | `scenarioId@version` from an allowlist (T4.11), plus its challenge list and their digest |
| Policy | the policy `id@version` the plan was evaluated under, from the stored plan (T2.14), not today's file |
| Implementation | git commit, executor engine version, provider projection versions, and the Era image digests from `infra/compose.yaml` |

A report is **stale**, and shown as stale, when any of these is true:

- a newer revision of the plan exists;
- the reviewer is looking at a different hash;
- the policy, image digests, projection versions or engine version differ from what the report names;
- it is older than 24 hours.

Staleness is computed when the report is read, not stored, so nothing is edited in place.

### 2. Authority: a report never grants anything

- Operational admission is unchanged. Apply needs a live grant for the exact revision and hash. Admission never reads rehearsal tables, and no rehearsal outcome creates, extends or stands in for a grant.
- There is no `skipApproval` option, no fake operational grant, and no rehearsal path into the operational executor.
- A report is advice on the review page. It is never required. It may later become an *additional* precondition that policy demands (it can only restrict), and that would need its own decision.
- **Rehearsal admission** is its own function, `admitRehearsal`, separate from `admit`:
  - the stored plan exists at that revision and hash;
  - the requester is a verified member of the org;
  - the plan passes the same graph and policy checks operational admission runs, so only an approvable plan is rehearsed;
  - the snapshot is supported (section 4);
  - the scenario is on the allowlist;
  - every world is a rehearsal world.

  It needs no grant and refuses any operational world.

### 3. Isolation, storage and credentials

- **Separate containers.** A third Era container set, one per vendor, on its own compose profile (`rehearsal`, ports 8103/8113/8123), with its **own admin token** `REHEARSAL_ERA_ADMIN_TOKEN`. Its tenants never share a container with planning or operational ones, so a rehearsal's faults can't reach a real run, and its admin token can't mint, reset or fault a real world. This is the new infrastructure this record allows; nothing else is added.
- **One tenant per rehearsal.** The tenant is `rh-<rehearsalId>`, chosen by the server. Data isolation between concurrent rehearsals relies on signed tenant tokens, which is tested. Fault isolation is not provided by tenants, so **only one rehearsal with challenges runs at a time per container set** (a Postgres advisory lock). Rehearsals without challenges may run side by side.
- **Separate storage.** Rehearsal jobs, attempts, receipts and reports live in their own tables (T3.13), with their own `rehearsal` queue. The operational journal is never written or read by a rehearsal, and the rehearsal journal is never read by operational admission or the executor. This is what makes fact 4 safe. Rehearsal operation keys are also namespaced (`rh_<rehearsalId>_<operation key>`), so even a mistaken join can't match an operational key.
- **A third worker role, `rehearsal`.**

  | Process | Holds | Refuses at startup |
  |---|---|---|
  | planner worker | model key, planning tokens (via its secret) | admin tokens, operational and rehearsal URLs, other workers' secrets |
  | executor worker | operational tokens (via its secret) | model keys, admin tokens, rehearsal URLs, other workers' secrets |
  | rehearsal worker | rehearsal tokens for one tenant at a time (via `REHEARSAL_WORKER_SECRET`) | model keys, both admin tokens, planning and operational URLs, other workers' secrets |
  | API (operator) | `ERA_ADMIN_TOKEN`, `REHEARSAL_ERA_ADMIN_TOKEN` | — |

  The executor and planner get `REHEARSAL_*` added to their forbidden lists. The mint route gives the rehearsal secret only rehearsal-world tokens, and only for a tenant of a rehearsal that is currently provisioned. The worker names the rehearsal; the server derives the tenant.
- **Admin provisioning stays operator code.** Seeding, reset, faults and teardown use `/_admin` routes with the rehearsal admin token only. They live in an operator module under `scripts/` (with tests), called by the API's operator side, the process that already holds the admin token (decision [0002](0002-era-tenant-token-minting.md)). No worker and no planner code calls `/_admin`.
- **What isn't claimed.** The boundary is credentials and startup checks, not the network. Locally every container listens on 127.0.0.1, and a tokenless request lands in tenant `default`. So a rehearsal worker given an operational URL by mistake could reach the operational container's `default` tenant. The startup check prevents that, but no network rule does.
  - In a deploy, the rehearsal worker should be on a network that can't reach planning or operational containers. That is a recommendation, untested.
  - The operational tenant must not be `default`. Today it is `ERA_TENANT=rehearsal-demo`, so that holds.
  - T4.13 tests the credential refusals and the forbidden routes (T1.23). Nothing in this record is a tested security boundary until T4.13 passes.

### 4. Supported snapshots

The snapshot is the **plan's own evidence**: the observations and query projections it cites, captured from the planning world. It is not a copy of production. The rehearsal seeds the tenant from them with `/inject`, using the plan's IDs.

A snapshot is supported only when both of these hold:

- every entity a step reads or writes has an observation with a projection version the seeder knows (`stripe.charge.v1`, `zendesk.ticket.v1`, and the customer balance once T1.14 lands);
- every query the plan cites is complete.

Anything else is refused before provisioning, with the reason, and never partially seeded. The cases refused include:

- an entity with no observation;
- a Slack channel's history (the summary channel is created empty);
- a projection that leaves out a field the simulator needs.

Fields outside the projection take the seeder's fixture defaults. The report lists them as "not from evidence".

### 5. Lifecycle and unknown outcomes

```text
requested → provisioning → running → verifying → completed | failed | cancelled → torn down
```

- Every state change is a new row.
- A step with an unknown outcome is reconciled by reads inside the rehearsal, exactly as in operation.
- If it is still unknown when the run ends, the report says **unknown**, never passed.
- The verifier (T4.12) reads the tenant before teardown. Teardown resets the tenant and is idempotent.
- A worker that dies mid-rehearsal leaves the tenant; T3.16's sweeper resets `rh-*` tenants whose rehearsal is terminal or whose lease expired.
- A rehearsal is never resumed into a fresh tenant under the same ID. A retry is a new rehearsal with a new tenant, because the old tenant's state is unknown.

### 6. Rollout

All of it is additive and off by default:

- a `"rehearsal"` world in contracts (T1.21). It is its own literal, `RehearsalWorld`, not a third value of `World`: widening `World` would let a plan manifest's evidence or an operational receipt name a rehearsal world;
- new tables and a new queue;
- the `rehearsal` compose profile.

The API registers the rehearsal routes only when the rehearsal URLs and admin token are set. `planHash` and every existing hash input stay as they are: a report refers to a hash and is not part of one, so existing plans can be rehearsed unchanged. To roll back, stop the profile; the tables just go unused.

### 7. Native Stripe sandbox (T1.24, T3.17, T3.18)

A real Stripe account is allowed only as a narrow test-mode target:

- The key must start with `sk_test_`. `sk_live_` and `rk_live_` are refused at startup and before every request. The account ID is pinned in the environment and checked against `GET /v1/account` before anything else.
- The key lives in a gitignored `.env.stripe-sandbox`. Only the conformance harness and, later, the rehearsal worker read it. Never the planner, never the operational executor, never a model.
- It is never an operational world, and it never stands in for one.
- A run creates its own charges (test payment methods, a run-specific metadata prefix) and refunds only those. Test-mode refunds can't be undone either, so cleanup means leaving them labelled, not deleting them.
- Evidence from it is labelled `native_stripe_test`, apart from `era_integration` and `fixture`, and states its fidelity limits.

## Consequences

- One more container set and one more worker process to run. The demo stack without the `rehearsal` profile is unchanged.
- Rehearsals with challenges are serialized, which bounds throughput. That's acceptable for a review step.
- T1.21 adds the contracts: the `"rehearsal"` world literal, rehearsal request, job, scenario reference, state events, step results and report, plus the tenant, operation-key, snapshot and staleness helpers in `core`.
- T1.23 adds the third worker's credentials and routing checks.
- T3.13 and T3.14 build the tables and `admitRehearsal` beside `admit`, without changing it.
- The isolation claims stay "designed, not tested" until T4.13 passes.
- Open for T3 and T4 review:
  - whether the 24-hour staleness window is right;
  - whether the API should hold the rehearsal admin token or a separate operator process should, which would be one more service and need its own decision.
