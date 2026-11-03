# SurrealDB Agent Memory: precedent store (T1.8)

Precedents live on hosted SurrealDB Agent Memory behind `PrecedentPort` (`packages/memory`). Memory is a recall index, never an authority ([build plan §7](source/build-plan.md#surrealdb-precedents), [decision 0009](decisions/0009-reopen-full-scope.md)): Postgres holds the approved version, and the executor checks a plan's citations against the registry, never against recall.

## How a precedent is stored

One `concept` entity named `precedent:<id>`, in one scope (default `rehearsal/precedents`), with three attributes written together as triples (`infer: "triples"`, no model):

| Key | Value |
|---|---|
| `record` | The canonical JSON (RFC 8785) of the whole `PrecedentRecord`. The only value readback trusts. |
| `statement` | Plain text, so recall has something to match. Must equal `record.statement`. |
| `version` | Plain text. Must equal `record.version`. |

- **Publish** registers the scope, refuses a version older than any stored one (or the same version with different content), writes, then reads back. Publishing the stored version again sends nothing, so the outbox can retry.
- **Readback** looks only at attributes tagged with exactly our scope, and fails on a missing, extra, duplicated or disagreeing key, a non-canonical record, or anything not stored as `knowledge`.
- **Recall** queries `/query` through the scope's lens and takes the hits only as candidates. Every precedent it returns comes from readback, effective today, with the fact IDs it was read from, the hit IDs and the trace ID. An outage fails recall instead of returning nothing.
- **Citation check** (`checkPrecedentBasis`) decides from a registry snapshot alone. It holds a plan when a cited precedent was superseded, withdrawn, not yet active or changed, or when the epoch of any area the plan consulted moved. The epoch covers precedents that recall never surfaced.

T2.17 added the Postgres registry (`precedent_events`, derived into a `RegistrySnapshot`), the `precedent-sync` queue that publishes an approved version and only then activates it, the finance-only promotion route and a promote panel ([decision 0012](decisions/0012-precedent-promotion.md)). Each organization gets its own memory scope. Since then plans carry a `PrecedentBasis` with the citations (T1.29), approval refuses a changed precedent (T2.17) and executor admission re-checks it against the registry (#258). The sync ran once against the hosted service in a throwaway scope (#238); **the planner's recall has not run against the hosted service inside the app yet** (#366), so a plan citing a precedent is `fixture` evidence.

## Keys

Each process holds one key, with only the grants its job needs (#365, decision 0012 §6):

| Variable | Held by | Grants below the precedent scope (`memoryKeyGrants`) |
|---|---|---|
| `SURREAL_AGENT_MEMORY_WRITE_KEY` | API (the sync) | `memory:read`, `memory:write`, `scope:create` |
| `SURREAL_AGENT_MEMORY_READ_KEY` | planner worker (recall) | `memory:read` |
| `SURREAL_AGENT_MEMORY_ADMIN_KEY` | operator tools and the memory gate only | the key Studio issues |

The planner worker refuses to start with the write or admin key, and the executor and the rehearsal worker refuse every memory key. A planner that could write memory could plant the precedent it then cites. The old shared `SURREAL_AGENT_MEMORY_KEY` is refused everywhere with a message naming its replacements. `pnpm memory:keys mint <label>` mints both keys with the admin key and prints each once; `pnpm memory:keys revoke <label>` revokes them.

The variable names are what the startup checks look at; the grants are what the service enforces. The memory gate mints both keys with the same grants and checks that the planner's recalls but is refused a write.

## Memory gate

```bash
MEMORY_GATE=1 pnpm test:memory   # PowerShell: $env:MEMORY_GATE=1; pnpm test:memory
```

Without `MEMORY_GATE=1` the gate is skipped and only the offline tests run (a fake that copies the semantics below). Each gate run uses its own scope under `rehearsal/test/`, mints and revokes its own narrowed keys with the admin key (`SURREAL_AGENT_MEMORY_ADMIN_KEY`), and erases the scope afterwards.

**PASS**, 6/6 on 3 consecutive runs (2026-10-24, Windows 11 amd64, Node 24.11.1, about 35 s each, most of it recall).

| Check | Result |
|---|---|
| Publish, then validate the stored copy on readback; republish stores nothing | **PASS** |
| Recall returns the exact version with fact IDs, hit IDs and a trace ID | **PASS** |
| Trace inspection: `GET /traces/{id}` names the query and the retrieved facts | **PASS** |
| Replace v1 with v2: readback is v2, history lists v2 then v1 (superseded); v1 again and v2 with other content are refused | **PASS** |
| Wrong scope: a key narrowed to a neighbouring scope gets 403 writing ours and sees nothing reading it; its forged copy of the same precedent doesn't change ours; once revoked it gets 401 | **PASS** |
| A plan citing v1 is held once v2 is approved (`superseded` plus `epoch_changed`); a replan on v2 passes | **PASS** |
| The API's key (#365) registers an org's scope and publishes; the planner's recalls it with a trace and is refused a write | **not run yet** (added after the runs above) |

## Surprises

Found probing the hosted service on 2026-10-24 (context `rehearsal-precedents`, AWS us-west-2, free plan).

1. **`Idempotency-Key` is ignored on `/facts`.** The docs promise a stored replay and `409` for a different body. In practice the same key with a different body was written. Retries are still safe, because writing the value an attribute already holds stores nothing new; publish doesn't send the header.
2. **Attributes are per scope.** The same entity and key written in another scope doesn't supersede ours: both stay live, and a key that reads both sees both on `GET /entities/...`. Anyone who can write a neighbouring scope can add a `statement` to our precedent's entity. That is why readback filters to exactly our scope.
3. **A `/` in an entity name 404s** on `GET /entities/{type}/{name}`, even percent-encoded. The write succeeds, so the entity is unreadable. Names use `precedent:<id>`.
4. **`/scopes/forget` ignores `dryRun: true`** and erases permanently. Only the test cleanup calls it.
5. **Scopes:** registering an existing scope returns `201` again, and missing parents are created. Paths are lowercase. `DELETE /scopes` takes `?path=` in the query string, not a body. Writing to a tombstoned scope is `400 unknown scope node`.
6. **Wrong-scope reads are empty, not refused.** A narrowed key reading outside its grant gets `404` for the entity and no hits from `/query`; only writes are refused (`403 … outside the caller's write region`).
7. **Recall is slow** (5–8 s per `/query` on the free plan), and the service was badly degraded once for about five minutes: authenticated calls took 25–45 s while `/health` stayed fast.
