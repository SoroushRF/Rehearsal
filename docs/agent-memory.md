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
- **Withdrawal** (T1.51, #367): withdrawing a precedent queues a `precedent-sync` job (`kind: "withdraw"`) that overwrites its three attributes with a withdrawal marker (`statement` = `withdrawn`, `version`, and `record` = `{"id","version","withdrawn":true}`) and reads it back. Writing the same keys supersedes the approved copy, so recall stops returning it and `/history` keeps it. Readback reports the marker as `withdrawn`, recall rejects it as `withdrawn at vN`, and the next published version replaces it. The job holds a per-precedent memory lock that publish also takes, and does nothing once a newer version is approved, so it can't cover a newer copy. A redelivered publish job for a withdrawn version doesn't put its copy back. The registry is still what decides: the marker only keeps recall from offering what the planner would drop.
- **Citation check** (`checkPrecedentBasis`) decides from a registry snapshot alone. It holds a plan when a cited precedent was superseded, withdrawn, not yet active or changed, or when the epoch of any area the plan consulted moved. The epoch covers precedents that recall never surfaced.

T2.17 added the Postgres registry (`precedent_events`, derived into a `RegistrySnapshot`), the `precedent-sync` queue that publishes an approved version and only then activates it, the finance-only promotion route and a promote panel ([decision 0012](decisions/0012-precedent-promotion.md)). Each organization gets its own memory scope. Since then plans carry a `PrecedentBasis` with the citations (T1.29), approval refuses a changed precedent (T2.17), executor admission re-checks it against the registry (#258), and a withdrawal retires the copy in memory (T1.51). The sync ran once against the hosted service in a throwaway scope (#238), and the [app gate](#precedent-gate-through-the-app-t150) now runs the whole chain against the hosted service: promote, sync, the planner's recall and citation by fact ID, withdraw, refuse (#366, 5/5 on 3 runs on 2026-11-02). That is a test on the hosted service with a scripted model and testkit planning reads, not an acceptance run of a deployed app.

## Recall diagnostics (T1.54)

While it builds the basis, `recallBasis` also records why each precedent was or wasn't recalled (`PrecedentRecallDiagnostics`): per area, the query sent (the area key), the trace ID, the hits with their fact and hit IDs, and each precedent dropped with its reason and stage. `recall` means Agent Memory's copy was absent, invalid, withdrawn or not effective; `registry` means recall found it but it isn't the active version and digest. With nothing active it records `recalled: false` and asks nothing. It is capped to `RECALL_DIAGNOSTICS_LIMITS` and to 256 KB serialized (`RECALL_DIAGNOSTICS_MAX_BYTES`): past that it drops every hit ID, then trailing hits the plan does not cite, then trailing areas, and logs what it cut.

The worker sends it in the completion's `stats`, and the API stores it in `plan_recall_diagnostics` beside the revision (append-only, one row per planned revision), never in the manifest, so the plan hash doesn't change. The API stores them only if they agree with the job and the basis: `recalled` matches whether the job had active precedents, the areas are exactly the basis's epochs with none repeated, no area lists a hit twice, and every citation is among the hits (same ID and version) of its own area or of the area whose trace found it. Otherwise, or if the write fails, it logs and keeps the plan; a failed read serves the plan without them. `GET /api/plans/:id` serves it from Postgres, never from Agent Memory, and only while the revision's basis is the one it explains (a reviewer's revision keeps its parent's). The citation card shows it under "Why these precedents", collapsed. It explains the citations and decides nothing: approval and admission still check the registry alone. Evidence: `fixture` (fake Agent Memory, Postgres 17); not run against the hosted service.

## Keys

Each process holds one key, with only the grants its job needs (#365, decision 0012 §6):

| Variable | Held by | Grants below the precedent scope (`memoryKeyGrants`) |
|---|---|---|
| `SURREAL_AGENT_MEMORY_WRITE_KEY` | API (the sync, and the promote panel's hint) | `memory:read`, `memory:write`, `scope:create` |
| `SURREAL_AGENT_MEMORY_READ_KEY` | planner worker (recall) | `memory:read` |
| `SURREAL_AGENT_MEMORY_ADMIN_KEY` | operator tools and the memory gate only | the key Studio issues |
| `SURREAL_AGENT_MEMORY_READ_KEY`, in `.env.drift` | the [drift check](#drift-check-t153) (operator) | `memory:read`, on a key of its own |

The planner worker refuses to start with the write or admin key, and the executor and the rehearsal worker refuse every memory key. A planner that could write memory could plant the precedent it then cites. The old shared `SURREAL_AGENT_MEMORY_KEY` is refused everywhere with a message naming its replacements. `pnpm memory:keys mint <label>` mints both keys with the admin key and prints each once; `pnpm memory:keys revoke <label>` revokes them. `pnpm memory:keys mint-reader <label>` mints `rehearsal-reader-<label>`, an operator's read-only key with the planner's grants, for the drift check. It is never the planner's own key and goes only in `.env.drift`. `pnpm memory:keys revoke-reader <label>` revokes it.

The variable names are what the startup checks look at; the grants are what the service enforces. The memory gate mints both keys with the same grants and checks that the planner's recalls but is refused a write.

## Memory gate

```bash
MEMORY_GATE=1 pnpm test:memory   # PowerShell: $env:MEMORY_GATE=1; pnpm test:memory
```

Without `MEMORY_GATE=1` the gate is skipped and only the offline tests run (a fake that copies the semantics below). Each gate run uses its own scope under `rehearsal/test/`, mints and revokes its own narrowed keys with the admin key (`SURREAL_AGENT_MEMORY_ADMIN_KEY`), and erases the scope afterwards.

**PASS**, 7/7 on 3 consecutive runs (2026-11-02, Windows 11 amd64, Node 24.11.1, about 50 s each, most of it recall). The first six checks also passed 6/6 on 3 consecutive runs on 2026-10-24, before the key check existed. With the drift check added (2026-11-03): 8/8 on 4 of 5 runs. The fifth run's 7/8 was the drift check hitting a 60 s test timeout (see below the table).

| Check | Result |
|---|---|
| Publish, then validate the stored copy on readback; republish stores nothing | **PASS** |
| Recall returns the exact version with fact IDs, hit IDs and a trace ID | **PASS** |
| Trace inspection: `GET /traces/{id}` names the query and the retrieved facts | **PASS** |
| Replace v1 with v2: readback is v2, history lists v2 then v1 (superseded); v1 again and v2 with other content are refused | **PASS** |
| Wrong scope: a key narrowed to a neighbouring scope gets 403 writing ours and sees nothing reading it; its forged copy of the same precedent doesn't change ours; once revoked it gets 401 | **PASS** |
| A plan citing v1 is held once v2 is approved (`superseded` plus `epoch_changed`); a replan on v2 passes | **PASS** |
| The API's key (#365) registers an org's scope and publishes; the planner's recalls it with a trace and is refused a write | **PASS** |
| Drift (T1.53): plant a missing, a stale, an unmarked-withdrawal, a waiting and an unknown copy in an org scope of the gate's own; a read-only key finds exactly those five, sending only reads and recall queries, and marks the waiting version's repair as one that activates it; the sync's own calls repair the first four; the check then finds only the unknown copy, which is left alone | **PASS** on 2 of 2 runs at 180 s; one earlier run timed out at 60 s |

All the drift check's hosted runs were on 2026-11-03 (Windows 11 amd64, Node 24.11.1, about 110 s for the whole gate):

| Run | Drift check | Result |
|---|---|---|
| 1, 2 | first version, 60 s timeout | **PASS**, 8/8; the drift check took 56.6 s in run 2 |
| 3 | same | 7/8: the drift check hit the 60 s test timeout. That was not an assertion or a service error. Most of the time goes on six recalls at 5–8 s each |
| 4, 5 | after review: waiting versions, grace period, re-read registry; 180 s timeout | **PASS**, 8/8; the drift check took 58.7 s and 57.9 s |

So the check needs about a minute on the free plan, and 180 s leaves room for a slow day. The registry in this check is rows in the test, and repair uses the calls the sync handler makes (`publish`, `markWithdrawn`), not the queue. The queue path is tested on real Postgres with the fake ([below](#drift-check-t153)).

## Drift check (T1.53)

Memory is derived from the registry, so the two can drift apart: a sync job fails for good, a copy is lost or changed in the service, a withdrawal's job never runs. One case was known before this check existed. Once a newer version is approved, a `withdraw` job does nothing. If that newer version's sync then fails for good, the withdrawn copy stays, and recall offers it to the planner. Admission still drops the citation, because the registry decides. The drift check compares an org's memory scope with its registry and reports where they differ.

```bash
pnpm memory:drift <org> [--repair [--activate-waiting]]   # one org, by its Clerk org ID
pnpm memory:drift --all [--repair [--activate-waiting]]   # every org with a registry
```

It prints a summary line per org and one line per finding.

| Exit code | Meaning |
|---|---|
| 0 | Memory matches the registry. |
| 1 | Drift found, whether or not repairs were queued. |
| 2 | Bad usage: an unknown flag (anything starting with `-`), no org or two, or `--activate-waiting` without `--repair`. |
| 3 | An error: a refused credential, missing settings, an Agent Memory outage, a database failure, or an org with no registry and nothing found ("no registry for this org; check the org id"). |

| Finding | Meaning | Repair |
|---|---|---|
| `missing` | A version is active, and memory holds nothing for it, a copy that fails readback, or a withdrawal marker. | Publish the active version. |
| `stale` | Memory holds an older version, a version the registry never approved, or content that differs from what finance approved. | Publish the active version if it is newer than the copy, otherwise the newer waiting version (activating, see below). None only for a copy at the newest approved version with other content, or one newer than any approved version: publish never overwrites a version or goes back. |
| `unmarked_withdrawal` | Memory still offers a version that was withdrawn, or superseded by one that was. | A `withdraw` job, or publishing the active version. If a newer version is approved and waiting, publish that one, because a `withdraw` job would do nothing (the known case above). That repair activates it. |
| `waiting` | A version was approved longer than 10 minutes ago and never activated: its sync failed for good. The line gives its age, measured from the approval. | Publish it, which activates it. |
| `unknown` | A `precedent:<id>` copy that the registry never approved. | None. Reported only, never deleted. |

Memory has no listing, so unknown copies are found through recall: one query per area the registry knows, plus `precedent`, each at the service's cap of 50 hits. That finds what recall would offer the planner, which is the copy that matters, but not necessarily every stored entity. Entity reads run 8 at a time.

**Waiting versions need `--activate-waiting`.** One kind of repair changes what execution sees: publishing a version that finance approved but whose sync failed. When that publish reads back, the sync records the version as active, as it would have the first time. Its area's epoch moves, and plans resting on the version before it are held at admission. So `--repair` alone queues only the repairs that leave the registry as it is: publishing an already-active version, or a `withdraw` marker. Repairs that would activate a waiting version are printed with `(activates it)` and `not queued: … pass --activate-waiting`. With `--activate-waiting` they are queued too. Where an activating publish is queued for a precedent, that precedent's other repairs are skipped, because the publish replaces its copy anyway.

**Syncs in flight.** A precedent with a version approved in the last 10 minutes is left out and printed as `in flight`, because its own sync may still be running. The check reads the registry again after reading memory, and drops any finding whose precedent changed in between (`changed …: the registry moved mid-check; run again`).

**What repair does.** It doesn't write to memory. For each repair it queues, it sends the API's own `precedent-sync` job through `enqueuePrecedentSync`, the same function and singleton key the API uses. The precedent queue has no pg-boss policy, so a singleton key alone doesn't stop a second job. Before sending, the check locks the key and looks for the same job waiting, retrying or running (`precedentSyncPending`). If it finds one, it prints `already queued` and doesn't send. Running `--repair` twice before the worker drains the queue therefore queues each job once. A job the API itself queued at the same moment could still be doubled; that's harmless, because the sync is idempotent. The API's sync handler then does the writing with its write key, under the same locks and checks as any other sync: a publish job for a withdrawn version does nothing, and a `withdraw` job never covers a newer version. The jobs only run while the API runs with Agent Memory configured. Run the check again afterwards to confirm. The check starts pg-boss only to send: it creates and updates no queues and runs no maintenance, and it fails if the API hasn't created the precedent queue yet.

**What repair doesn't do.** The registry decides, and the check never changes it. It approves nothing, withdraws nothing and deletes nothing. It holds or releases a plan only in the one case above, and only with `--activate-waiting`: activating a waiting version that finance already approved.

**Key.** The check holds a read-only key and `DATABASE_URL`, nothing else. Mint the key with `pnpm memory:keys mint-reader <label>` and put it in `.env.drift` (gitignored), together with `SURREAL_AGENT_MEMORY_URL`, `_CONTEXT` and `DATABASE_URL`. `pnpm memory:drift` reads that file, not `.env`, and refuses to start with the write or admin key, the old shared key, the model key, or the planner's or executor's secrets. Revoke the key with `pnpm memory:keys revoke-reader <label>`.

| Evidence | Result |
|---|---|
| Each finding and its repair against the fake Agent Memory, the grace period, dropping findings the registry changed under, 8 reads at a time, and that the check sends only reads and recall queries (`packages/memory/test/drift.test.ts`) | **PASS**, fixture |
| End to end on real Postgres and pg-boss with the fake (`apps/api/test/memory-drift.test.ts`, 2026-11-03, Windows 11, Node 24.11.1). `--repair` queues the three safe repairs and leaves the gap's activating publish; a second `--repair` queues nothing new (`already queued`); `--activate-waiting` adds the publish once; the API's sync handler runs the four jobs; a last check finds only the unknown copy. Also covered: a version in its grace period, a sync landing mid-check, an org with no registry, a send-only pg-boss, and the exit codes for bad usage and refused keys | **PASS**, fixture |
| The memory gate's drift check ([above](#memory-gate)) | **PASS** on 2 of 2 runs at 180 s; one earlier run timed out at 60 s. Hosted (2026-11-03) |

## Precedent gate through the app (T1.50)

The memory gate tests the library. This one tests the chain through the app (#366), on real Postgres and pg-boss in a database of its own (`rehearsal_precedent_gate`):

1. A finance lead promotes a precedent from a completed run (`POST /api/runs/:id/precedents`); it's **waiting**.
2. The API's sync handler, built from the API's env (write key), publishes and reads it back; it's **active**.
3. The planner's read key is refused a write.
4. A rehearsal (`POST /api/incidents/:id/rehearse`) queues a plan job carrying the org's registry. The planner worker's own job client claims it over HTTP, `recallersFromEnv` recalls in the org's scope with the read key, and the stored plan cites the precedent by version, digest, the three fact IDs and the trace ID. The approval check holds.
5. Finance withdraws it; `POST /api/plans/:id/approvals` answers `409 precedent_changed` (`withdrawn`, `epoch_changed`). The withdrawal's queued job, run by the API's sync handler, overwrites the copy with the withdrawal marker; readback says `withdrawn` and history still holds v1 (T1.51).
6. With a second precedent active in the area, a replan recalls again. Recall no longer offers the withdrawn copy, and the plan cites only the other one.

The stand-ins are IAM (the real rule file), the model (a fixed script) and the planning world's reads (testkit records).

```bash
DB_TESTS=1 pnpm test:precedent-gate                 # fake Agent Memory; CI runs this
DB_TESTS=1 MEMORY_GATE=1 pnpm test:precedent-gate   # hosted, needs SURREAL_AGENT_MEMORY_ADMIN_KEY
```

Hosted, it mints its own API and planner keys from `memoryKeyGrants`, works under `rehearsal/test/app-gate-<run>`, then revokes the keys and erases the scope. The hosted runs show the API's `scope:create` grant below the base scope is enough to register an org's scope on first sync.

| Run | Result |
|---|---|
| Fake Agent Memory, Postgres 17 (2026-11-03, Linux, Node 24) | **PASS** 5/5 |
| Hosted Agent Memory, Postgres 17 (2026-11-02, Windows 11 amd64, Node 24.11.1, about 20 s each) | **PASS** 5/5 on 3 consecutive runs |
| Hosted, with the withdrawal marker (T1.51; 2026-11-03, same machine, about 30 s each) | **PASS** 5/5 on 3 consecutive runs |

## Similar precedents on the promote panel (T2.32)

Before finance promotes, the panel can show the active precedents in the same area that recall finds similar to the draft (#397). It is a hint and nothing else.

- `POST /api/runs/:id/precedents/similar` takes `{ appliesTo, statement, id? }` (Zod, strict) and needs `rehearsal:promote:precedent` in the run's org, like promotion itself. A run in another org is a 404, and a run that hasn't completed is a 409.
- It recalls in the org's scope with the **API's own key** (the write key's `memory:read` grant), never the planner's, asking for the service's cap of 50 hits because the area filter runs after the cut. The planner is still the only process whose recall feeds a plan.
- The registry decides what is shown, read again after recall returns so a withdrawal that lands mid-recall still counts. A hit appears only if Postgres lists that exact version and digest as active, in the same area. The statement shown is read from Postgres, not from recall, so a withdrawn precedent whose copy memory still holds, or a copy that is a version behind, is dropped.
- It always answers `200` with a status: `ok`, `off` (Agent Memory isn't configured) or `unavailable` (recall failed or took over 10 s). The panel says which, and says nothing blocks (a 403 says a finance lead is needed instead). An empty answer reads "None found among the closest matches", not "none exist". Recall is skipped when the registry has nothing active in the area.
- Nothing is stored, queued or approved, the promote route never calls it, and the promote button doesn't wait for it, so promotion works the same with memory off or failing. The plan hash isn't involved.
- A failed recall is logged with the org, the error kind and the HTTP status only. The client takes no abort signal, so entity reads still in flight when the 10 s deadline passes run to their own timeout and are ignored.

| Evidence | Level |
|---|---|
| API tests on real Postgres against the fake Agent Memory: similar, none, a withdrawn copy, a copy a version behind, another org with the same id and area, more than ten better-ranked off-area copies, a withdrawal mid-recall, memory off, outage and timeout; web unit tests; the precedents e2e spec | `fixture` |

**Not verified against the hosted service.** This is the first time `/query` is called with the API's write key (its `memory:read` grant); every hosted check so far queried with the read key. The memory gate would show whether the service accepts it.

## Surprises

Found probing the hosted service on 2026-10-24 (context `rehearsal-precedents`, AWS us-west-2, free plan).

1. **`Idempotency-Key` is ignored on `/facts`.** The docs promise a stored replay and `409` for a different body. In practice the same key with a different body was written. Retries are still safe, because writing the value an attribute already holds stores nothing new; publish doesn't send the header.
2. **Attributes are per scope.** The same entity and key written in another scope doesn't supersede ours: both stay live, and a key that reads both sees both on `GET /entities/...`. Anyone who can write a neighbouring scope can add a `statement` to our precedent's entity. That is why readback filters to exactly our scope.
3. **A `/` in an entity name 404s** on `GET /entities/{type}/{name}`, even percent-encoded. The write succeeds, so the entity is unreadable. Names use `precedent:<id>`.
4. **`/scopes/forget` ignores `dryRun: true`** and erases permanently. Only the test cleanup calls it.
5. **Scopes:** registering an existing scope returns `201` again, and missing parents are created. Paths are lowercase. `DELETE /scopes` takes `?path=` in the query string, not a body. Writing to a tombstoned scope is `400 unknown scope node`.
6. **Wrong-scope reads are empty, not refused.** A narrowed key reading outside its grant gets `404` for the entity and no hits from `/query`; only writes are refused (`403 … outside the caller's write region`).
7. **`valid_until` only applies to relations.** On an attribute write it is refused (`422`, "only valid on relation entries"); spelled `validUntil`, or put at the top of the request, it is silently ignored (probed 2026-11-02). Superseding is the only way to retire an attribute: write the same key again, and the old fact gets `supersededBy` and a `validUntil`, leaves recall and stays in `/history`. Withdrawal uses that (T1.51).
8. **Recall is slow** (5–8 s per `/query` on the free plan), and the service was badly degraded once for about five minutes: authenticated calls took 25–45 s while `/health` stayed fast.
