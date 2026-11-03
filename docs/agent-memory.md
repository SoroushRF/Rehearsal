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

The planner worker refuses to start with the write or admin key, and the executor and the rehearsal worker refuse every memory key. A planner that could write memory could plant the precedent it then cites. The old shared `SURREAL_AGENT_MEMORY_KEY` is refused everywhere with a message naming its replacements. `pnpm memory:keys mint <label>` mints both keys with the admin key and prints each once; `pnpm memory:keys revoke <label>` revokes them (every generation, since [rotation](#rotating-the-keys-t155)). `pnpm memory:keys mint-reader <label>` mints `rehearsal-reader-<label>`, an operator's read-only key with the planner's grants, for the drift check. It is never the planner's own key and goes only in `.env.drift`. `pnpm memory:keys revoke-reader <label>` revokes it.

The variable names are what the startup checks look at; the grants are what the service enforces. The memory gate mints both keys with the same grants and checks that the planner's recalls but is refused a write.

### Rotating the keys (T1.55)

```bash
pnpm memory:keys rotate <label>                # mint the next pair; the old pair keeps working
pnpm memory:keys status <label>                # each generation's created and last-used times; never a key
pnpm memory:keys rotate <label> --revoke-old   # once the new pair is deployed: revoke the old one
```

Generations are told apart by name. Generation 1 is what `mint` makes (`rehearsal-api-<label>`, `rehearsal-planner-<label>`); each `rotate` mints the next, `rehearsal-api-<label>-g<N>` and `rehearsal-planner-<label>-g<N>`, with the same grants (`memoryKeyGrants`). So a label may not end in `-g<digits>`. `rotate` prints each new key once, as the line for its env file, then the deploy steps; that is the only time a key is printed. It refuses a label with no keys yet (use `mint`), and `mint` refuses a label that already has keys of any generation. If the second mint fails, it revokes the first and logs whether that worked; if the cleanup fails too, it says which key is still live and to run `pnpm memory:keys revoke <label>`. That key was never printed, so nobody holds it.

`rotate`, `revoke` and `--revoke-old` refuse when the label's live generations look ambiguous: numbers with a gap, or a generation created before the one below it. That is what an older label ending in `-g<N>` would look like (`rehearsal-api-prod-g2` parses as generation 2 of `prod`), from before such labels were refused. Revoking the "older generations" of `prod` would then revoke another label's deployed pair. A legacy label that happens to line up with the next generation can't be told apart this way; `status` prints every generation's dates for a check by eye.

`--revoke-old` lists the live keys (`GET /keys`, which returns names and timestamps, never the key) and revokes every generation older than the newest complete pair. It never revokes that pair, and refuses when nothing older exists. An incomplete newer generation is left alone and reported.

Before revoking anything it prints a check from `GET /keys`. It refuses (exit 3, nothing revoked) when a kept key shows no `lastUsedAt`, when an old key was used after the kept key of the same role was last used, or when an old key was used in the last 15 minutes. `--force` revokes anyway, and `status` prints the same check without revoking. The review asked for a refusal whenever an old key was used after the new pair was created. That would refuse every rolling deploy, since the old instances keep using the old key until the deploy finishes, so the check asks for the old keys to have gone quiet instead.

The check can only refuse on what the service reports; it can't prove the old keys are free. On the hosted service `lastUsedAt` stayed empty for a pair used for a write and two reads, and for another pair it was set on first use and then didn't move after a write, a denied write and a recall ([Surprises](#surprises), 12). So the runbook's deploy check comes first, and every check prints that caveat. `revoke` and `--revoke-old` exit 3 when any `DELETE /keys` failed, naming the keys still live; running again revokes what's left. `revoke <label>` revokes every generation of the label. The deploy runbook is in [deployment.md](deployment.md#rotating-the-agent-memory-keys-t155). Never paste a key into chat or a ticket: it goes straight from the terminal into its one service's field.

## Erasing an org's memory (T1.55)

```bash
pnpm memory:erase-org <org>               # dry run, then type the org ID to erase
pnpm memory:erase-org <org> --yes <org>   # for scripts: the same ID twice, or it exits 2
pnpm memory:erase-org <org> --force       # erase even though Postgres and memory disagree
```

An operator command, under `scripts/` only, with the admin key and `DATABASE_URL` (both in `.env`). App code never erases memory. In order:

1. **Dry run.** `/scopes/forget` ignores `dryRun` (see [Surprises](#surprises)), so the command runs its own, with reads only (`GET /scopes`, recall queries, entity and history reads). It first prints what it acts on: the database (`host:port/name`, never the credentials), the Agent Memory URL and context, and the base scope. Then the org's scope and whether it is registered, and each entity it can read there with its live and history attribute counts. Memory has no entity listing, so it reads every precedent the registry knows for the org, plus whatever recall finds through the scope's lens for each of the org's areas and for `precedent`, at the cap of 50 hits. A copy the registry never approved is found that way.

   Then it refuses (exit 3, nothing recorded) when the two sides disagree, unless `--force`: the registry has precedents for the org but memory holds none, or memory holds entities but the registry has none for the org; or the scope isn't registered, unless it is already tombstoned. Each mismatch is printed. These usually mean the wrong `DATABASE_URL` or memory context, which is why the targets come first.
2. **Typed confirmation.** The operator types the org ID exactly. Anything else, or a closed stdin, aborts with exit 1, and nothing is erased or recorded. `--yes <org>` must name the same org, or the command exits 2 before reading anything.
3. **`erased` in Postgres, first.** An append-only row in `memory_erasure_events` (migration `0011_memory_erasures`). From this row on, the org is refused (below). The row is written while holding the org's memory lock exclusively. Every sync holds that lock shared while it writes, so a sync already running finishes first and is erased with the scope, and a later one sees the row and writes nothing.
4. **Forget and tombstone.** `POST /scopes/forget` on the org's scope, then `DELETE /scopes?path=…`. A tombstoned scope can't be written again, even if something registers it once more (probed). A crash before this step leaves the org refused but its memory still held; running the command again finishes it. On a rerun where the listing already says `tombstoned`, it sends no `DELETE`, and sends forget only if something there still reads as live; otherwise it logs that nothing was sent. Forget on a tombstoned scope answers `200 {"forgotten":0}` ([Surprises](#surprises), 13).
5. **`forgotten`** in Postgres, with the count the service reported, then the after-check: the same listing again, the registry's entities plus the recall probes, so a copy only recall could find is checked too. Anything still live fails the command (exit 3).

Exit codes: 0 erased, 1 aborted, 2 bad usage or a mismatched `--yes`, 3 an error, a mismatch or something still live after forget. Running it again on an erased org appends another pair of rows; rows are never edited.

`memory_erasure_events` is a table of its own rather than a new kind in `precedent_events`: erasure is about an org, not a precedent version, and the registry's derivation would otherwise have to skip a kind it doesn't know.

**From the `erased` row on, each of these refuses the org:**

| Path | What it does instead |
|---|---|
| The API's precedent sync (`precedent-sync` jobs, publish and withdraw) | Writes nothing, logs, and completes as `org_erased`, so it isn't retried. |
| The planner's recall | A plan job queued after the row carries no registry for the org (`planJobRegistry`), as in core mode: the planner recalls nothing and the plan has no precedent basis (no recall diagnostics are stored, since nothing was asked). A job queued before the row still holds the registry in pg-boss, and `/next` hands it out without it (`withoutErasedMemory`). A job the planner had already taken when the row was written fails at `/complete` as `org_erased` if its plan has a basis, and pg-boss retries it once (`retryLimit: 1`), now without memory. If that retry is already used up, the rehearsal fails and can be run again. Planning works as before. |
| The similar-precedents hint (T2.32) | Answers `200 { status: "off" }` without recalling. |
| The drift check | Refuses the org before reading memory, so it can't queue a publish into it: exit 3 when the org is named, a line and no error under `--all`. |
| Promoting a new precedent | Refused, `409 memory_erased`; the panel says why. The promote transaction takes the org's memory lock shared before it checks, in the sync's order (the org's lock, then the precedent's), so it can't pass the check while the `erased` row is being written. The sync would never publish the new version, so it would wait forever. A version already waiting when the org was erased stays waiting. Withdrawing still works: it only changes Postgres. |

**What erasure doesn't do.** It doesn't touch `precedent_events`: the registry keeps every approved version and its status, and stays the authority. It doesn't touch execution or admission. A plan that already cites an erased org's precedents still checks against Postgres at approval and admission, as any plan does: it holds if a precedent changes in the registry, not because memory was erased. New plans have no basis, so nothing holds them for precedent reasons. Erasure is permanent for that org ID: there is no command to undo it, and the tombstoned scope can't be written again.

| Evidence | Result |
|---|---|
| Rotation against the fake (`packages/memory/test/keys.test.ts`, 11 tests, no database): names and generations, same grants, both pairs work after rotate, `--revoke-old` revokes only older generations, then the old keys get 401; the check before revoking (a kept key never used, an old key used after it or in the last 15 min) and `--force`; failed revokes reported, and exit 3 from the command; `mint` refusing a label with keys; ambiguous generations refused; cleanup of a half-minted pair, logged, and what to run when it fails; `status` printing no key; usage | **PASS**, fixture |
| Erasure on real Postgres with the fake, through the command itself and its function (`apps/api/test/memory-erase.test.ts`, 2026-11-03, Windows 11, Node 24.11.1; 18 tests: 1 usage test without a database, 17 DB-gated): the dry run prints its targets, lists and changes nothing; mismatches refuse with exit 3 unless `--force`; a rerun on a tombstoned scope sends nothing; a forget that leaves a copy only recall finds fails the after-check; a wrong or missing confirmation aborts; the typed ID erases and tombstones only that scope and records `erased` then `forgotten`; the registry is unchanged; `erased` is written before forget is sent, and a failed forget leaves the org refused until a rerun finishes; the event waits for a sync holding the org's lock, including a real `syncPrecedent` with a slow publisher; promotion waits for an erasure holding the lock, then gets 409; a plan job queued before the erasure is handed out without the registry, one taken before it fails `org_erased` and its retry plans without a basis; the repair route for an erased org queues a job without the registry; then the sync, the plan job, the hint, promotion and drift refuse the org, and an existing plan's basis still checks against Postgres | **PASS**, fixture |
| The memory gate's rotation and erasure checks ([below](#memory-gate)), hosted, 2026-11-03. The erasure check records its events in the test, not Postgres: the `erased` row, the lock and the sync's refusal are fixture-only | Erasure **PASS** on 5 of 5 runs. Rotation **PASS** on 3 of 3 runs before the review. The review's check failed on runs 4 and 5 and was changed after run 5, so its final form has not run hosted (see the gate) |

## Memory gate

```bash
MEMORY_GATE=1 pnpm test:memory   # PowerShell: $env:MEMORY_GATE=1; pnpm test:memory
```

Without `MEMORY_GATE=1` the gate is skipped and only the offline tests run (a fake that copies the semantics below). Each gate run uses its own scope under `rehearsal/test/`, mints and revokes its own narrowed keys with the admin key (`SURREAL_AGENT_MEMORY_ADMIN_KEY`), and erases the scope afterwards.

**PASS**, 7/7 on 3 consecutive runs (2026-11-02, Windows 11 amd64, Node 24.11.1, about 50 s each, most of it recall). The first six checks also passed 6/6 on 3 consecutive runs on 2026-10-24, before the key check existed. With the drift check added (2026-11-03): 8/8 on 4 of 5 runs. The fifth run's 7/8 was the drift check hitting a 60 s test timeout (see below the table). With rotation and erasure added (T1.55, 2026-11-03, same machine, 150–195 s each): 10/10 on 2 of 3 runs. In the first run both new checks passed, and the older replan check (a plan held once v2 is approved) failed: one `/query` hit the client's 30 s timeout. That was the service being slow, not an assertion; the whole run took 195 s against about 155 s for the next two. Two more runs after the review (runs 4 and 5, 190 s and 235 s): 9/10 each. Every check passed except rotation, whose new `--revoke-old` check went ahead where the test expected a refusal, because `GET /keys` didn't show the old keys' use (Surprises, 12). The check now also refuses an old key used in the last 15 minutes and prints that `lastUsedAt` can't prove anything. The gate's rotation check now records the listing after each step and revokes with `--force`. That form has not run hosted; the gate runs allowed for this review were used up.

| Check | Result |
|---|---|
| Publish, then validate the stored copy on readback; republish stores nothing | **PASS** |
| Recall returns the exact version with fact IDs, hit IDs and a trace ID | **PASS** |
| Trace inspection: `GET /traces/{id}` names the query and the retrieved facts | **PASS** |
| Replace v1 with v2: readback is v2, history lists v2 then v1 (superseded); v1 again and v2 with other content are refused | **PASS** |
| Wrong scope: a key narrowed to a neighbouring scope gets 403 writing ours and sees nothing reading it; its forged copy of the same precedent doesn't change ours; once revoked it gets 401 | **PASS** |
| A plan citing v1 is held once v2 is approved (`superseded` plus `epoch_changed`); a replan on v2 passes | **PASS**; on 2026-11-03 one of three runs lost a recall to the client's 30 s timeout |
| The API's key (#365) registers an org's scope and publishes; the planner's recalls it with a trace and is refused a write | **PASS** |
| Drift (T1.53): plant a missing, a stale, an unmarked-withdrawal, a waiting and an unknown copy in an org scope of the gate's own; a read-only key finds exactly those five, sending only reads and recall queries, and marks the waiting version's repair as one that activates it; the sync's own calls repair the first four; the check then finds only the unknown copy, which is left alone | **PASS** on 2 of 2 runs at 180 s; one earlier run timed out at 60 s. Also passed on the 3 T1.55 runs (55–63 s) |
| Rotation (T1.55), in labels of the gate's own: generation 1 publishes and reads; `--revoke-old` refuses with one generation; after `rotate` both generations work and the new planner key is still refused a write; `--revoke-old` revokes generation 1 only, which then gets 401, and generation 2 still works | **PASS** on runs 1–3 (about 10 s). Runs 4 and 5 (after the review): failed, the check went ahead where a refusal was expected. Everything before that step passed. Now records `GET /keys` per step and revokes with `--force`; not run hosted in that form |
| Erasure (T1.55), in an org scope of the gate's own: the dry run lists the one entity (3 live, 3 in history), records nothing and leaves it readable; erase records `erased` then `forgotten`; readback is absent, recall finds nothing, and a publish into the tombstoned scope is refused (400). From run 4: forget on the tombstoned scope is probed (answer recorded in run 5), and a rerun finds it tombstoned and sends nothing | **PASS** on 5 of 5 runs (37–39 s on runs 1–3) |

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
- It always answers `200` with a status: `ok`, `off` (Agent Memory isn't configured) or `unavailable` (recall failed or took over 30 s). The panel says which, and says nothing blocks (a 403 says a finance lead is needed instead). An empty answer reads "None found among the closest matches", not "none exist". Recall is skipped when the registry has nothing active in the area.
- Nothing is stored, queued or approved, the promote route never calls it, and the promote button doesn't wait for it, so promotion works the same with memory off or failing. The plan hash isn't involved.
- A failed recall is logged with the org, the error kind and the HTTP status only. The client takes no abort signal, so entity reads still in flight when the 30 s deadline passes run to their own timeout and are ignored.

| Evidence | Level |
|---|---|
| API tests on real Postgres against the fake Agent Memory: similar, none, a withdrawn copy, a copy a version behind, another org with the same id and area, more than ten better-ranked off-area copies, a withdrawal mid-recall, memory off, outage and timeout; web unit tests; the precedents e2e spec | `fixture` |

**Not verified against the hosted service.** This is the first time `/query` is called with the API's write key (its `memory:read` grant); every hosted check so far queried with the read key. The memory gate would show whether the service accepts it.

## Surprises

Found probing the hosted service on 2026-10-24 (context `rehearsal-precedents`, AWS us-west-2, free plan).

1. **`Idempotency-Key` is ignored on `/facts`.** The docs promise a stored replay and `409` for a different body. In practice the same key with a different body was written. Retries are still safe, because writing the value an attribute already holds stores nothing new; publish doesn't send the header.
2. **Attributes are per scope.** The same entity and key written in another scope doesn't supersede ours: both stay live, and a key that reads both sees both on `GET /entities/...`. Anyone who can write a neighbouring scope can add a `statement` to our precedent's entity. That is why readback filters to exactly our scope.
3. **A `/` in an entity name 404s** on `GET /entities/{type}/{name}`, even percent-encoded. The write succeeds, so the entity is unreadable. Names use `precedent:<id>`.
4. **`/scopes/forget` ignores `dryRun: true`** and erases permanently. Only the test cleanup and `pnpm memory:erase-org` call it; the command lists with reads only first, for that reason.
5. **Scopes:** registering an existing scope returns `201` again, and missing parents are created. Paths are lowercase. `DELETE /scopes` takes `?path=` in the query string, not a body. Writing to a tombstoned scope is `400 unknown scope node`.
6. **Wrong-scope reads are empty, not refused.** A narrowed key reading outside its grant gets `404` for the entity and no hits from `/query`; only writes are refused (`403 … outside the caller's write region`).
7. **`valid_until` only applies to relations.** On an attribute write it is refused (`422`, "only valid on relation entries"); spelled `validUntil`, or put at the top of the request, it is silently ignored (probed 2026-11-02). Superseding is the only way to retire an attribute: write the same key again, and the old fact gets `supersededBy` and a `validUntil`, leaves recall and stays in `/history`. Withdrawal uses that (T1.51).
8. **Recall is slow** (5–8 s per `/query` on the free plan), and the service was badly degraded once for about five minutes: authenticated calls took 25–45 s while `/health` stayed fast.
9. **`GET /keys` lists names only** (with `createdAt` and `lastUsedAt`), never a key's value or grants, and a revoked key disappears from it rather than being marked. So rotation tells generations apart by name (`-g<N>`), and a key can be shown only once, when it is minted (probed 2026-11-03).
10. **`/scopes/forget` on a scope nobody registered** returns `200 {"forgotten":0}`, not `404`. Its count isn't attributes either: one entity with one fact counted 3. The erase command records the count as the service reported it and checks the result by reading again (probed 2026-11-03).
11. **A tombstone is permanent.** After `DELETE /scopes`, registering the same path again returns `201`, but writes there are still `400 unknown scope node`. `GET /scopes` lists tombstoned paths with a `tombstonedAt`, which is how the erase command's listing tells them apart (probed 2026-11-03).
12. **`lastUsedAt` in `GET /keys` is not a record of use.** In gate run 5 (2026-11-03) generation 1 of a label was used for a write and two reads, and still listed `lastUsedAt` empty. Generation 2's keys got a `lastUsedAt` on first use, and it didn't move after a write, a denied write and a recall over the next 15 s or so. Run 4 failed the same way, which fits, but recorded nothing more. Whether it is set later, sampled or batched, two runs can't say. So `--revoke-old`'s check can refuse on what it sees but can't show that nothing runs on an old key; the runbook relies on the deploy check.
13. **`/scopes/forget` on a tombstoned scope** returns `200 {"forgotten":0}`, as for a scope never registered (Surprise 10), not an error (gate run 5, 2026-11-03; run 4 sent it too, but its answer was not kept). The erase command doesn't send it on a rerun unless something there still reads as live.

## Public release verification (2026-11-03)

The final T1.55 library gate passed all 139 memory tests, including the revised rotation,
drift and disposable-scope erasure checks. Rotation still uses `--force` inside the test's
throwaway label: this verifies the keys and revocation, not the reliability of `lastUsedAt`.
The probes again observed used old keys reporting no use and new timestamps not advancing.

The hosted app gate now checks the similar-precedents route with the API's write key and
serves the planner's recall diagnostics from Postgres without changing the manifest/hash.
All six checks passed. One earlier similar request exceeded the old 10 s advisory deadline;
the panel now has a 30 s budget and promotion remains independent. The successful measured
request took 7.8 s. IAM, model and planning reads in this gate are fixtures; Postgres and
Agent Memory are real. This does not establish an Era or signed-in Render workflow.

T1.57 also covers erasure during a job's last ordinary attempt: recovery strips the stored
registry and grants only the needed retry under the same job id, in one transaction fenced
to the active attempt. Jobs already without memory cannot replenish that recovery.
