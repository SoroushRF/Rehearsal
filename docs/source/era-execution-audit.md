# Rehearsal: Era and execution capability audit

Checked October 18, 2026, against the complete 13-page brief. This is technical verification of the selected project, not another idea comparison.

**Verdict: a bounded Stripe + Zendesk local-simulator build is supported by much stronger evidence than the brief has. Public shipped image source implements refunds, invoice-balance adjustments, Stripe idempotency, and Zendesk `safe_update` checks. A running integration remains a day-one gate. The full design is not a seven-day commitment, even with four AI-assisted builders.**

The most important correction is that the workflow is not generally reversible. A successful refund and an appended ticket comment are effects you preserve and reconcile. Demonstrate conditional compensation on a separate ticket field change. Real production safety, arbitrary backup-to-fork conversion, atomic cross-vendor execution, and complete predicate concurrency protection remain outside the verified capability.

## Evidence and access

- **Official docs refreshed over HTTPS:** nine `console.era.eon.io` docs/compatibility pages returned 200 and were saved as `LIVE-*` beside this report. The normal web reader failed; a narrowly scoped external-network shell read succeeded. `https://console.era.eon.io/compat/stripe.json` returned **404**. That is a missing manifest, not absence of a Stripe simulator.
- **Public image metadata inspected:** anonymous Docker registry reads confirmed Linux amd64 and arm64 images for Stripe, Zendesk and Slack, all last pushed October 10. No account, private registry credentials or production credentials were used.
- **Public source actually inspected:** downloaded only the small source layers from those images plus the shared simcore source layer, approximately 4.6 MB compressed altogether. Archive SHA-256 values match registry layer digests. Extracted sources are in `era-image-inspection/`. This improves on the earlier finding that the public GitHub repository lacks simulator implementation: implementation is available inside public image layers.
- **Locally executed:** `node --version` = 24.11.1; `python --version` = 3.14.0; Docker client 29.1.3 exists, but the Linux engine pipe is absent. Docker Desktop/daemon was not started. No simulator, container, dependency installation or external vendor action ran.
- **One limited source-function probe executed:** `python era-extracted-guard-probe.py` extracts selected AST functions without importing/running the service. It confirmed matching stamps pass, different stamps raise 409, and second-resolution stamps can collide. `era-extracted-guard-probe-results.json` is evidence of this isolated probe only, **not** a server/HTTP/concurrency/vendor test.

Pin these inspected **amd64 manifest digests**, rather than mutable `latest`:

| Image | Inspected manifest digest |
|---|---|
| `erabyeon/stripe` | `sha256:2fc38cae60b0c330418feb7225c8d70a5fd14a01fe0ce87646e7234a8afe53ad` |
| `erabyeon/zendesk` | `sha256:ae8f43fcaa40941dfd6c75296e5746745538cbf687f9a86ffbbe8e637be4b626` |
| `erabyeon/slack` | `sha256:47bc71e1372f8f94a128d151107147fc242284ab2ed62b732d6e6209f0778cf4` |

The image configuration reports `ERA_IMAGE_TAG=189e10c16ec66ee1ca24ac5f7962cd7637174d0f`. Saved tag responses: `LIVE-docker-{stripe,zendesk,slack}-latest.json`. [Stripe metadata](https://hub.docker.com/v2/repositories/erabyeon/stripe/tags/latest), [Zendesk metadata](https://hub.docker.com/v2/repositories/erabyeon/zendesk/tags/latest), [Slack metadata](https://hub.docker.com/v2/repositories/erabyeon/slack/tags/latest).

Source-layer digests: Stripe `158456f58073027a4f507db00c35377b5656137c62ceaf525077339386f2418b`; Zendesk `b3a0a5b9521d399185a99d94bb463c4639535044922c6ef67e23a7743fe0b8c4`; Slack `68d8e6d6ac12f8686e56470c4cd03aace70f25aeaf81d26008bd76b290c08d2e`; inspected Stripe simcore `1431aa87f551dcff5d159cb259a4adf9d7791b8fa2dc979f83acbc0dbcc52262`. All are SHA-256 values. Source file references below are relative to `era-image-inspection/`.

## What Era provides, precisely

| Capability | Current evidence | Effect on design |
|---|---|---|
| Local client writes | Official `SIMCORE_ALLOW_CLIENT_WRITES=1`; `GET /_meta` reports permission. Hosted console companies remain read-only. | Use local images for both planning and simulated production. |
| Deterministic baseline | Pin image, `SIMCORE_SEED`, `SIMCORE_TODAY`, `SIMCORE_STATE=day1`, **`SIMCORE_FIDELITY=high`**, and every fixture/recipe field. | Same seed alone is insufficient. Verify relevant baseline reads equal before planning. |
| Tenant isolation | Explicit header works in local open mode; signed tenant claims and strict/operator rules can supersede/refuse plaintext headers. | Gateway chooses tenant server-side; never let agent choose production or admin routing. |
| Loading fixtures | `POST /_admin/tenants/{T}/dataset` rebuilds recipe; `POST /_admin/tenants/{T}/inject` applies native resource records. | Use explicit tenant routes and canonical fixture bytes. |
| Reset | `POST /_admin/tenants/{T}/reset` drops injections/client changes. | Reset then reapply the baseline recipe+fixtures before each test. |
| Faults | `POST /_admin/faults`, `POST /_admin/faults/reset`; container-wide, not tenant-specific. | Separate fork/prod containers, or run fault scenarios serially. |
| Snapshot/export/fork | `GET /_admin/tenants/{T}/dataset` calls `TenantManager.snapshot`, which returns a **descriptor**, not current vendor records. | Do not advertise an arbitrary live fork/export API. Controlled identical starting worlds are sufficient for the demo. |
| Built-in evaluation | `era evaluate` is documented as an Education assignment grader using environment ground truth. | Build your own executor/invariant scorecard; do not assume it grades plan hashes, compensation, or local mutation traces automatically. |

[Write settings](https://console.era.eon.io/docs/allow-writes-in-a-simulator.md), [hosted write boundary](https://console.era.eon.io/docs/what-your-agent-can-and-cant-change.md), [settings](https://console.era.eon.io/docs/simulator-settings.md), [load/reset](https://console.era.eon.io/docs/load-data-into-a-simulator.md), [faults](https://console.era.eon.io/docs/make-a-simulator-fail-on-purpose.md), [CLI/evaluate](https://console.era.eon.io/docs/era-cli-commands.md).

Shipped source clarifies payloads more than the docs: shared `admin.py:324-361` rebuilds from a recipe and extracts `body.inject`; `admin.py:1313-1324` only turns `inject` and table/schema fields into overlays. Posting raw `{"charges":[...]}` to `/dataset` does not establish those records were loaded. Use the inject route or wrap native records in `inject`. `tenancy.py:3840-3885` establishes that the dataset GET is descriptor-only. Files are under `simcore/simcore/simcore/`.

Illustrative recipe body, identical for the fork and simulated production:

```json
{"seed":42,"scale":25,"state":"day1","industry":"fintech"}
```

Illustrative Zendesk inject body:

```json
{"tickets":[{"id":90005531,"subject":"Billing incident INV-812","status":"open","priority":"normal","external_id":"incident-812","comments":[{"body":"Duplicate charge on my invoice","public":true}]}]}
```

Stripe injection accepts collection-name lists and records with IDs, but does not complete the whole object for you (`stripe/app/stripe_sim/store.py:1146-1164`). Copy a **complete actual GET response** as the charge/customer fixture template, then alter the relevant fields and references. Zendesk injection supplies skeleton defaults, accepts organizations/users/tickets, and supports explicit ticket comment threads (`zendesk/app/zendesk_sim/store.py:5870-5951`). Handwritten partial Stripe objects can fail unrelated read/render paths.

Never inject late into an applying plan as if injection were an ordinary vendor update: its rebuilding/reprojection semantics differ. Use actual vendor-shaped writes for the teammate-edit trap, and reserve inject for controlled setup/new-record traps whose effects are separately checked.

## Minimal action vocabulary

Keep the planner behind a few typed domain tools and adapt them to vendor REST. Arbitrary REST/MCP recording is unnecessary for this deadline and cannot infer every decision dependency from value flow.

| Domain operation | Exact vendor-shaped call | Source verification | Label |
|---|---|---|---|
| `createRefund(charge, amountMinor, currency)` | `POST /v1/refunds`, form fields `charge=ch_...&amount=4210`, stable `Idempotency-Key` | Stripe `api.py:1192-1250` creates refund, transaction and charge effects. | Irreversible after success; reconcile result. |
| Optional `creditInvoiceBalance(customer, amountMinor, currency)` | `POST /v1/customers/{id}/balance_transactions`, form `amount=-4210&currency=usd` | Stripe `api.py:4889-4918`. | Compensable by a new opposite ledger transaction, not delete/restore. |
| `patchTicket(ticket, fields, expectedStamp)` | `PUT /api/v2/tickets/{id}.json`, wrapped `ticket` object | Zendesk `api.py:8046-8069`. | Conditionally compensable fields only. |
| `appendPrivateNote(ticket, body, expectedStamp)` | Same PUT, `comment:{body:...,public:false}` | Same REST route plus `store.update_ticket`. | Append-only effect; a corrective note is not rollback. |
| Full/stretch `appendPublicReply` | Same PUT, explicit `public:true` | Same route. | Irreversible disclosure/notification. |
| Full/stretch `postSummary(channel, text)` | `POST /api/chat.postMessage`, JSON `channel`, `text`, optional metadata | Slack `api/chat.py:130-157` and `store.py:3737-3806`. | Irreversible disclosure; deleting does not retract what readers saw. |

These are implemented routes in the inspected image source, not successful live HTTP calls. Full API verification still requires the smoke suite below.

**Refund is different from credit.** A Stripe refund targets a charge/PaymentIntent and returns money through its payment rail; enforce positive integer minor units and observed charge currency. An invoice-balance credit uses a negative transaction amount and offsets invoices; it is not cash or a general service entitlement. Credit notes and cash balances are different resources. The trimmed workflow should choose refund only first, or explicitly keep the two remedies mutually exclusive per incident. [Refund API](https://docs.stripe.com/api/refunds/create), [balance transaction API](https://docs.stripe.com/api/customer_balance_transactions/create), [invoice balance behavior](https://docs.stripe.com/billing/customer/balance).

**Refund fidelity gap:** simulator creation hardcodes `status:"succeeded"`. Its cancel route accepts `pending`; current Stripe documentation restricts cancellation to `requires_action`. This is a concrete simulator/vendor divergence. Do not use cancellation as the saga inverse or use simulator success to claim real settlement behavior. [`api.py:1222`, `1275-1284`; real cancellation contract](https://docs.stripe.com/api/refunds/cancel).

**Dispute support exists in source:** `GET /v1/disputes` filters by `charge`/`payment_intent` (`api.py:1305-1310`). That does not certify every dispute lifecycle or refund eligibility interaction. Rehearsal must explicitly guard its chosen policy against disputes and updated ticket claims; the refund handler itself does not establish that business safeguard.

## Conditional writes: implemented, with a meaningful limit

The brief's uncertainty about Zendesk can be narrowed. This is not merely metadata:

```json
{"ticket":{"priority":"high","safe_update":true,"updated_stamp":"2026-10-18T14:00:00Z"}}
```

`zendesk/.../api.py:7364-7384` compares `updated_stamp` to the stored ticket `updated_at`, raises 409 `UpdateConflict` on inequality, and requires a stamp when safe mode is enabled. The REST update route invokes that check immediately before synchronous `store.update_ticket`; there is no `await` between check and mutation in that route. It supports a meaningful single-worker demo. This does **not** establish multi-process locking or every race behavior.

**Timestamp collision caveat:** `_zendesk_ts` formats to whole seconds (`store.py:1631-1632`), and `_touch_ticket` stamps writes with it (`6273-6277`). Two different updates in one second can share the value accepted by the equality guard. The extracted-helper probe reproduced that equality limitation. Run an actual server test for the same-second case; do not call this a unique version/CAS token.

Use a fresh relevant-field fingerprint/readback **plus** the vendor precondition. Re-reading after an unprotected write can detect damage but cannot prevent or retract it. Without a unique atomic precondition, say **best effort**. A narrow per-resource lock protects your own executor only; it does not stop another client.

MCP `update_ticket` exposes guards; MCP `add_ticket_comment` does **not** expose `safe_update` or `updated_stamp`, and defaults public visibility to true (`mcp_server.py:1532-1605`). Prefer the typed REST adapter for notes so explicit visibility and guards travel together. [Zendesk's current safe-update contract](https://developer.zendesk.com/documentation/ticketing/managing-tickets/creating-and-updating-tickets/#protecting-against-ticket-update-collisions), [comment creation/visibility](https://developer.zendesk.com/api-reference/ticketing/tickets/ticket_comments/).

No `If-Match`/`If-Unmodified-Since` implementation was found by search across inspected Stripe and Zendesk source; don't silently add those headers and call writes protected. Salesforce remains cut; its behavior was not inspected here.

## Plan, dependencies and symbolic IDs

Record domain intent, exact parameters, read dependencies, complete query predicates, selected fields, result memberships, policy version, adapter version, expected outcome, compensation classification and explicit dependency edges. Hash canonical typed JSON, not rendered HTML, object insertion order, wall timestamps or a raw HTTP transcript. Approval includes tenant/environment, expiration, approver and role constraints; execution atomically claims the approved plan in your own database.

Use an explicit symbolic result reference, for example `refund_812.id`, in the approved note template. At execution, bind it to the returned production ID in a durable map. Do not string-replace IDs throughout JSON or treat arbitrary model-generated text as a dependency graph. Freeze exact text/templates at approval; only predeclared bounded result slots may be substituted without another approval.

**Important demo trap:** Stripe `store.mint` keys runtime IDs to seed/state/counter, not tenant (`store.py:788-796`). Identical twins may generate identical new IDs, hiding a broken remapper. Insert an unrelated create in simulated production before applying, then assert the dependent note references the new apply ID, not the rehearsal ID.

Compare a step's current dependencies with its **expected state after already-applied approved predecessors**, not blindly against the original snapshot. Your own refund changes `amount_refunded`; your own field edit changes the ticket stamp. Keep the frozen original readset for audit, and advance a deterministic expected-state overlay only from confirmed receipts. Otherwise your own writes generate false stale holds. Unexpected collateral changes remain reviewable.

Phantom checks must enumerate all pages and compare sorted matching-ID sets plus relevant projections for the precise predicate, including previously empty results. Replaying only the IDs the agent returned, a top-k search, a single page, or an LLM's recollection of its query does not establish population completeness. Freeze query cutoff, time zone and supported query syntax. Apply invalidation to dependent customer steps; hold the entire plan if a cross-customer invariant cannot safely survive partial execution. Re-running a predicate still leaves a check/write race without a shared transactional boundary.

## Idempotency, retries and ambiguous outcomes

Stripe's inspected middleware resolves a tenant store before reading its idempotency map (`middleware.py:288-320`), so fork and production caches are separate. It caches accepted POST results, rejects key reuse with a different fingerprint, recognizes an in-flight key, and excludes injected pre-handler faults from the cache (`304-349`). Its fingerprint uses **path plus raw request-body bytes**. Persist the exact encoding before dispatch; semantically identical reordered form fields can mismatch. No time-based pruning was found in that inspected map path; never infer the real Stripe retention policy from it.

Real Stripe API v1 stores the first executed result including 500s, can prune after at least 24 hours, and rejects mismatched parameters. A stable key does not make the entire cross-system plan atomic. [Stripe idempotency reference](https://docs.stripe.com/api/idempotent_requests).

Implement a durable write-ahead operation journal: `ready -> dispatched -> confirmed | rejected | unknown`, plus `held`, `compensation_required`, and `compensation_conflict`. Persist plan hash, operation key, exact payload, attempt, provider request ID and returned resource ID. A process crash after dispatch is **unknown**, not a definite failure. Restart resumes reconciliation before a new mutation.

Refund retry uses the same key and bytes; list/read back refund state and correlate with a namespaced incident/operation metadata value as needed. Never create a fresh refund key merely because a timeout occurred. A retryable 429 requires `Retry-After` and bounded jitter/backoff; validation/auth errors require a hold rather than repeated attempts.

Zendesk comment append and Slack post have no proven equivalent universal idempotency guarantee here. `client_msg_id` in inspected Slack is copied to an already-created message; post/store paths do not perform a duplicate check. An accepted flag is not honored deduplication. Put an operation marker in your own approved note text or supported metadata, persist returned audit/comment/message identifiers, and reconcile uncertain sends. If evidence cannot distinguish sent from not sent, hold for inspection rather than blind retry. [Slack post contract](https://docs.slack.dev/reference/methods/chat.postMessage/).

Built-in faults occur before handlers. They demonstrate throttle/retry behavior, **not** the hard lost-response-after-success case. Add a local transport wrapper that lets the simulator commit then drops the response; keep that wrapper visibly separate from Era's native fault feature.

## Compensation and the two hero traps

- **Mutable field trap:** patch a ticket priority/assignee, let an independent teammate write another value, then cause a later step to fail. Compensation rereads the changed field and current stamp. Revert only if the field still equals the exact value Rehearsal wrote, using the supported precondition; otherwise preserve the teammate edit and emit `compensation_conflict`. Write only the particular field, not the whole preimage or a stale tag array. External notification/automation effects can still survive a field restoration.
- **Phantom trap:** record the complete customer/incident charge predicate, approve, introduce a new matching charge, rerun the predicate and hold the associated remedy plus its note. Also include a nonmatching new charge as a benign control.
- **Refund/append boundary:** a later note/Slack failure never causes the engine to claim the refund disappeared. Keep the confirmed refund receipt, hold/reconcile communications and show partial completion. A new reversing invoice-balance transaction is compensating accounting, not history erasure, and may be inappropriate after credit consumption.

Prefer communications as terminal per-customer steps, with a final aggregate summary constructed from confirmed receipts. Partial outcomes need an approved deterministic summary template, not an agent silently rewriting the approved statement. Private notes reduce external disclosure but remain append-only operations.

## Decisive smoke suite for the team

Run this before polishing UI or generating thousands of training labels. These are **required future checks**, not claims that they passed here.

1. Start pinned images locally, bound to `127.0.0.1`, with admin access withheld from the agent; assert `_meta` write-enabled. Also run one read-only refusal control.
2. Load one canonical recipe and complete fixtures into fork/prod; independently compare all relevant Stripe charge/customer/refund/dispute and Zendesk ticket/comment reads. Mutate fork only and prove prod stays unchanged; reset/reload and prove equality returns.
3. Execute one partial refund; retrieve it, the charge and refund list independently. Replay identical key/bytes twice; count one refund. Reuse key with changed bytes and expect rejection. Repeat same key in the other tenant and verify separate effects.
4. Lose a successful refund response and restart the executor. Same operation must reconcile to one refund, with dependent communication withheld until confirmation.
5. Read ticket stamp; another client changes it; stale guarded PUT must return409 and preserve the other edit. Test correct stamp, missing stamp, private note visibility, same-second edits, and post-write readback separately.
6. Force fork/apply ID divergence and inspect the persisted symbolic binding in the dependent private note.
7. Trigger matching and nonmatching new charges across pagination boundaries; assert only relevant dependent steps hold. Include empty-at-plan-time predicate.
8. After a successful reversible field patch, fail the next operation. Verify inverse without an external edit; then external edit before compensation and verify it survives. Do not attempt refund reversal.
9. Inject `fail_next:2` and `retry_after_seconds:1`; verify bounded retry timing and one effect. Separately test after-commit response loss for notes/Slack: no blind duplicate.
10. Crash between every journal transition; replay approved hash twice; change one approved parameter; expire/revoke approval. Assert no unapproved dispatch, no duplicate remedy and recoverable unknown outcomes.

Use a small 5-10 customer world first. The 180-customer/400-change counters are load scenarios after correctness works, not requirements for first proof. Faults affect every tenant in one container; isolate or serialize these tests.

## Full versus trimmed architecture effect

**Trimmed commitment:** one billing incident, one monetary remedy initially, Stripe refund + Zendesk mutable field patch + explicit private note, typed tools, deterministic DAG, plan hash approval, durable SQLite/Postgres journal, symbolic IDs, complete supported predicates, clear conditional/best-effort labels, two hero traps, honest partial completion and around20 invariant scenarios. Add optional Slack finalizer after this passes. A day-one image/HTTP smoke is still essential despite source confirmation. Node/Python availability is sufficient for implementation; Docker engine availability remains an environment gate.

For four fast AI-assisted builders, the honest core split is: (1) pinned Era deployment/fixtures/adapters/traps, (2) plan schema/review UI/Clerk/approval, (3) executor/journal/remapping/guards/recovery, (4) integration tests/evaluation/demo/release. The brief's person4 dedicated model track deprives the hardest integration of an owner before it is working. They can move to the model only after the core gates pass, or timebox a small independent feasibility experiment.

**Full stretch:** both refund and invoice-balance credit with correct accounting classification; public customer replies and Slack with ambiguous-send reconciliation; broader saga adapters; per-entity targeted replanning; SurrealDB policy precedents; counterfactual labeling/training and model serving. Every added write needs its own guard, return schema, normalization, idempotency/reconciliation and inverse classification. Fine-tuning cannot repair a missing conditional API, unobserved dependency, incomplete predicate, or unknown dispatch outcome. Do not let `unaffected` from the impact model bypass an exact hard guard.

The same vendor-shaped API can serve both paths, but production adapters require native staging tests and contract/version checks. Era explicitly says it implements a subset, simplified validation/auth/timing and no assurance that the real integration works. [Official fidelity boundary](https://console.era.eon.io/docs/how-simulators-differ-from-the-real-products.md). The accurate demo claim is: **“We rehearsed and applied an approved bounded plan across two isolated local Era worlds, detecting these measured drift/failure cases.”**
