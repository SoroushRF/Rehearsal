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

Not here yet: the Postgres `precedent_registry` and outbox, the finance-only promotion route and UI (T2.17), the planner recording citations in a plan (needs a contracts change), and the executor running the check.

## Memory gate

```bash
MEMORY_GATE=1 pnpm test:memory   # PowerShell: $env:MEMORY_GATE=1; pnpm test:memory
```

Without `MEMORY_GATE=1` the gate is skipped and only the offline tests run (a fake that copies the semantics below). Each gate run uses its own scope under `rehearsal/test/`, mints and revokes its own narrowed key, and erases the scope afterwards.

**PASS**, 6/6 on 3 consecutive runs (2026-10-24, Windows 11 amd64, Node 24.11.1, about 35 s each, most of it recall).

| Check | Result |
|---|---|
| Publish, then validate the stored copy on readback; republish stores nothing | **PASS** |
| Recall returns the exact version with fact IDs, hit IDs and a trace ID | **PASS** |
| Trace inspection: `GET /traces/{id}` names the query and the retrieved facts | **PASS** |
| Replace v1 with v2: readback is v2, history lists v2 then v1 (superseded); v1 again and v2 with other content are refused | **PASS** |
| Wrong scope: a key narrowed to a neighbouring scope gets 403 writing ours and sees nothing reading it; its forged copy of the same precedent doesn't change ours; once revoked it gets 401 | **PASS** |
| A plan citing v1 is held once v2 is approved (`superseded` plus `epoch_changed`); a replan on v2 passes | **PASS** |

## Surprises

Found probing the hosted service on 2026-10-24 (context `rehearsal-precedents`, AWS us-west-2, free plan).

1. **`Idempotency-Key` is ignored on `/facts`.** The docs promise a stored replay and `409` for a different body. In practice the same key with a different body was written. Retries are still safe, because writing the value an attribute already holds stores nothing new; publish doesn't send the header.
2. **Attributes are per scope.** The same entity and key written in another scope doesn't supersede ours: both stay live, and a key that reads both sees both on `GET /entities/...`. Anyone who can write a neighbouring scope can add a `statement` to our precedent's entity. That is why readback filters to exactly our scope.
3. **A `/` in an entity name 404s** on `GET /entities/{type}/{name}`, even percent-encoded. The write succeeds, so the entity is unreadable. Names use `precedent:<id>`.
4. **`/scopes/forget` ignores `dryRun: true`** and erases permanently. Only the test cleanup calls it.
5. **Scopes:** registering an existing scope returns `201` again, and missing parents are created. Paths are lowercase. `DELETE /scopes` takes `?path=` in the query string, not a body. Writing to a tombstoned scope is `400 unknown scope node`.
6. **Wrong-scope reads are empty, not refused.** A narrowed key reading outside its grant gets `404` for the entity and no hits from `/query`; only writes are refused (`403 … outside the caller's write region`).
7. **Recall is slow** (5–8 s per `/query` on the free plan), and the service was badly degraded once for about five minutes: authenticated calls took 25–45 s while `/health` stayed fast.
