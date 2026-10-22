# 0002: Where Era tenant tokens are minted (Oct 21)

## Context

With `SIMCORE_ADMIN_TOKEN` set, Era ignores a plaintext `X-Sim-Tenant` and serves every client request from tenant `default` ([capability matrix](../capability-matrix.md), surprise 1). A tenant is selected only by a signed JWT that each container's IdP mints with the admin token. Tokens last one hour.

The admin token can also reset, inject and fault any world, so neither worker may hold it. The planner may only ever reach the planning world, and the executor only the operational world.

## Decision

- **The API process is the operator.** It alone holds `ERA_ADMIN_TOKEN` and exposes `POST /internal/era/tenant-token` (`apps/api/src/tenant-tokens.ts`). The route is registered only when the admin token is set.
- **Each worker authenticates with its own secret:** `PLANNER_WORKER_SECRET` or `EXECUTOR_WORKER_SECRET`. The secret, not the request, decides the world: the planner's secret mints planning tokens, the executor's mints operational ones. The request names only the vendor. The API refuses to start if the two secrets are equal.
- **Workers cache and refresh.** `workerWorlds(role)` in `packages/providers` gives each worker its Stripe and Zendesk `WorldConfig`, each with a `RefreshingTokenSource`. The source re-mints 5 minutes before expiry. If a refresh fails, it keeps using the old token while that token is still valid. After expiry, `get()` throws. `eraFetch` awaits the source before sending, so a missing token stops the request. Nothing falls back to the plaintext tenant.
- **Startup checks are extended.** The planner refuses `ERA_ADMIN_TOKEN`, the operational URLs and `EXECUTOR_WORKER_SECRET`. The executor refuses `ANTHROPIC_API_KEY`, `ERA_ADMIN_TOKEN` and `PLANNER_WORKER_SECRET`. Both mint once at startup, so a misconfigured minter fails at boot.
- Operator scripts (`scripts/inject`, `scripts/seed`, the conformance harness) keep minting directly with the admin token. They are operator tools.

## Consequences

- Workers now need the API running (`REHEARSAL_API_URL`) to start and to refresh. If the API is down for more than the 5-minute margin, workers stop making Era requests until it's back. That's the intended fail-closed behaviour.
- No new infrastructure. It's one internal route plus two shared secrets.
- On a public deploy, `/internal/*` must not be reachable from the internet, or the secrets must be strong. Both workers and the API share a private network in the planned deploy (decision 0001, item 5).
- The planner's tool-loop code (T1.5) and the executor's write adapters (T3.3) take worlds from `workerWorlds()`. They never call `resolveWorld` with a tenant of their own.
