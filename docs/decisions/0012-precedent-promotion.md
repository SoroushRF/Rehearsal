# 0012: Promoting a precedent (T2.17)

**Status:** proposed 2026-10-24 (Parsa, T2). Needs a T3 reviewer (new tables, a queue) and a T1 reviewer (the memory package, org scoping).

## Context

[0009](0009-reopen-full-scope.md) allows SurrealDB Agent Memory as the precedent store only: Postgres holds the approved version, memory is a recall index, and the executor never asks recall whether anything is authorized ([build plan §7](../source/build-plan.md#surrealdb-precedents), [agent-memory.md](../agent-memory.md)). T1.8 built the adapter (`packages/memory`: `AgentMemoryPrecedents`, `checkPrecedentBasis`) and left out the Postgres registry and outbox, the promotion route and its UI. This record covers those, the parts T2.17 owns.

## Decision

1. **The registry is append-only events.** One table, `precedent_events`, org-scoped: `approved` (carries the full record and its digest), `activated` (memory sync succeeded) and `withdrawn`. Nothing is edited. A new version is a new `approved` event.
2. **Active and epochs are derived, not stored.** A precedent is active at the version of its latest `activated` event unless a later `withdrawn` follows. An area's epoch is the number of `activated` and `withdrawn` events in it, so activating, replacing or withdrawing any precedent moves it, whether or not recall ever surfaced that precedent. `precedentRegistry.snapshot(orgId)` returns exactly the `RegistrySnapshot` that `checkPrecedentBasis` takes.
3. **Promotion is a finance-only command on a completed run.** `POST /api/runs/:id/precedents` takes the case-specific content (`id`, `appliesTo`, `statement`, `conditions`, `exceptions`, `effectiveFrom`, `effectiveUntil`) and nothing else. The server sets the author (the verified user, role `finance_lead`), `approvedAt` and the version (the next one for that `id`); the browser never supplies them. A precedent keeps its area: a new version of an existing `id` with another `appliesTo` is refused. The run it came from is recorded on the event.
4. **Not active until synced.** The same transaction that writes `approved` enqueues a `precedent.sync` job (pg-boss, as apply does, so a crash can't leave one without the other). The handler calls `AgentMemoryPrecedents.publish` (write, then read back) and only then appends `activated`. Retries are safe because publish is idempotent. If memory isn't configured the job waits and the precedent stays "waiting for sync", which the UI says; core plans are unaffected.
5. **One memory scope per organization.** `rehearsal/precedents/org-<first 16 hex of sha256(orgId)>`. A single shared scope would let one organization's planner recall another's precedents; Clerk org IDs are mixed case and the service only takes lowercase paths, hence the hash. The sync handler builds one `AgentMemoryPrecedents` per organization.
6. **Credentials.** The sync job needs a memory **write** key; planning needs a **read** key. They are different keys, and the write key lives only with whoever runs the sync handler (the API process, which already holds the queue and Clerk keys), never the executor worker. The planner worker would get a read-only key. This is a proposal for T1 and T3 to confirm.

## What T2.17 needs from others

| From | What | Why |
|---|---|---|
| T3 | Review of the `precedent_events` table and migration (`packages/db`), and of the `precedent.sync` queue | Their paths; additive and nothing else reads them yet |
| T3 | The executor calling `checkPrecedentBasis` with `snapshot()` at admission and holding dependent steps | Without it a changed precedent doesn't hold a plan (the "memory gate" item) |
| T1 | Plans carrying `PrecedentBasis` (a contracts change) and the planner recording citations with trace IDs | The review page can't show "recalled precedents with their trace" until a plan has them |
| T1 / ops | Agent Memory URL, context and a write key and a read key as environment, and access to the hosted service | The sync handler and recall; without them promotions stay pending |

## What is built now, without credentials

The migration, the registry (approve, activate, withdraw, snapshot, list), the promotion route and its refusals, the sync handler with memory injected (tested with a fake), and the UI to promote from a completed run and see each precedent's status. All of it runs with memory unconfigured.

## Consequences

- With memory unconfigured, a promotion is accepted and stays `approved` forever; nothing is planned from it. That is deliberate and visible.
- The epoch only moves on activation and withdrawal, so a promoted-but-unsynced precedent holds no plan.
- **Withdrawal (added for #233):** finance only, `POST /api/precedents/:id/withdraw` with the version the reviewer saw as active (a stale page is refused, like a changed hash). It appends `withdrawn` under a per-precedent transaction lock that the sync's activation also takes, so the two can't interleave. A newer version that is still waiting is its own approval and becomes active if its sync completes.
- Agent Memory keeps its copy after a withdrawal (the service has no delete we rely on). That is safe because the registry, not recall, is the authority: whoever recalls must drop anything the registry doesn't list as active (#235), and admission checks citations against the registry (#234).
- **Plan basis (added for #235):** `PrecedentBasis` now lives in `@rehearsal/contracts` and `PlanManifest` has an optional `precedentBasis` (part of the plan hash only when present, so every earlier plan keeps its hash). Approval refuses a plan whose cited precedent was replaced, withdrawn or changed, or whose area's epoch moved (409 `precedent_changed`, with the holds), and `GET /api/plans/:id/approvals` reports the same check for the Approve button. The review page lists each citation with its trace and fact count. The planner recording the basis (T1) and the executor re-checking at admission (T3, #234) are still to do.
