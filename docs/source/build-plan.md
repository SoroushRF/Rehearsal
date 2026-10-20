# Rehearsal build plan

Prepared October 18, 2026. Decisions for the selected project, based on all 13 pages of the attached project brief, current official event/product documentation, inspected public Era image implementation, and a limited extracted-source helper probe. This is a technical specification and delivery plan; no application, simulator HTTP deployment, training run or account integration was implemented by this review.

## 1. Product and scope to freeze

Rehearsal lets an operations reviewer inspect and approve a bounded business-action plan, then applies the approved actions while detecting changed assumptions and recording actual outcomes.

**First workflow:** an approved billing incident has a stated customer/charge population and remedy policy. An agent investigates supported Stripe and Zendesk records in a controlled planning world, proposes refunds and ticket changes, and produces a reviewable plan. A separate executor applies that plan to a separate simulated operational world.

In the hackathon, both worlds are local Era simulators. This is not a demonstrated copy of a real bank, live backup restoration, cross-vendor transaction or arbitrary-agent security boundary. Avoid the brief's closing recovery claim unless an actual Eon recovery integration is built and tested. A more accurate closing line is: **“Rehearse the plan. Approve its effects. Apply with evidence.”**

Build **one common core**, then attach full-version features through stable ports. Do not maintain separate full/trimmed implementations or branches.

### Fixed feature matrix

| Capability | Trimmed release | Full target | Owner |
|---|---|---|---|
| Incident + approved synthetic policy, 5-10 customer fixture | Required | Required; larger measured batch after correctness | A + D |
| Planning through bounded typed tools against Era fork | Required | Required | A |
| Before/after semantic diff and source evidence | Required | Required | B/C |
| Explicit per-customer dependency graph, exclude customer/step | Required | Required | B/C |
| Immutable plan, canonical hash, role-bound expiring approval | Required | Required; two distinct approvers where policy requires | B/C |
| Row changes + complete supported query membership checks | Required | Required | A/B |
| Journal, retries, unknown-outcome reconciliation, ID bindings | Required | Required | B |
| Stripe refund | Required; only monetary remedy initially | Required | A/B |
| Zendesk mutable field patch + explicit private note | Required | Required | A/B |
| Conditional field compensation and conflict preservation | Required with explicit protection limit | Same; more supported steps only after conformance | B |
| Public customer reply and Slack final summary | Cut; private note is sufficient | Add exact approved templates + uncertain-send handling | A/B/C |
| Invoice-balance credit as alternative to refund | Cut | Add only after native/simulator semantic checks | A/B/D |
| SurrealDB reviewed precedents | Cut | Explicit promotion, retrieval citations, version invalidation | A + C |
| Actual LoRA experiment and base-vs-tuned evaluation | Bounded parallel deliverable; never blocks core | Required experiment; serve as advice if gate passes | D |
| Learned impact classifier inside execution authorization | Excluded | Excluded under proposed safety boundary | — |
| Expo approver | Cut | Thin native client after web/API contract stable | C |
| Historical audit interface | Current receipt/evidence viewer | Add exact historical plan/policy view | C |
| Shadow sampling/model-use map | Cut | Last stretch; report sampled counts honestly | D |
| Cloud Run GPU serving | Cut | Optional hosting upgrade if quota/access already work | D |
| Salesforce, arbitrary HTTP/MCP proxy, universal rollback | Excluded | Excluded this week | — |

Full target is deliberately broader than the release commitment. A failed extension gate removes that extension, not Rehearsal.

**Do not pivot to a different industry if one Era capability fails.** Stay on Rehearsal and narrow the supported action vocabulary. Preserve the evidence status of any substitute.

### Policy rules for the initial fictional company

These are authored demo rules, not financial/regulatory requirements:

1. A refund must match an approved obligation, customer, charge and currency; amount is a positive integer in minor units and within the permitted remedy and observed refundable amount.
2. A known completed remedy for the same obligation prevents a second independent remedy. Distinct legitimate obligations remain possible.
3. Refunds at/above the chosen demo threshold need the finance role. Full version may require support + finance from distinct users.
4. Missing or contested decision evidence holds the affected case; a model confidence number cannot grant permission.
5. A note/message may describe only outcomes supported by receipts, using an approved template. Unresolved financial outcomes cannot become “completed refund” statements.

Start with one currency, one remedy type and a precise incident cohort. Put policy in ordinary typed functions with versioned fixtures. Do not introduce a policy language, OPA server or generic policy builder this week.

## 2. What has actually been verified

| Item | Evidence now | Remaining execution gate |
|---|---|---|
| Event deadline/resources | Current Devpost/Luma pages read | Team registration/account entitlements not inspected |
| Era local writes/tenant/admin/fault contracts | Official docs refreshed + public image source inspected | Start pinned images and run HTTP conformance |
| Stripe refund/idempotency/dispute routes | Shipped source inspected | Real requests, retry/reconciliation and readback |
| Zendesk safe_update/updated_stamp | Shipped route inspected; isolated helper probe executed | Server race, same-second collision and private note tests |
| Slack post/client_msg_id | Shipped source inspected; no dedupe found in post path | Actual uncertain-send behavior |
| Node/Python/Docker CLI | Node 24.11.1, Python 3.14, Docker CLI 29.1.3 observed | Docker daemon was unavailable; no containers ran |
| Training hardware | RTX 4070 Laptop, 8188 MiB GPU memory observed | Compatible CUDA/PyTorch/Unsloth update-save-reload smoke |
| Clerk/Agent Memory/runtime libraries | Current official contracts read | Install/typecheck and actual account roundtrips |
| Era event guide | Linked public preview identifies PDF; owner-disabled download; text inaccessible | Team obtains permitted viewing/access |
| SurrealDB participant pack | Official linked Notion reports no public access | Team obtains published/authenticated access |

The pinned public image inspection is strong source evidence, not a replacement for a running test. Full details and reproducible evidence are in REHEARSAL-ERA-EXECUTION-AUDIT.md.

### Important implementation findings

- Hosted Era data is read-only. Local client writes require SIMCORE_ALLOW_CLIENT_WRITES=1.
- Pin image digest, seed, state, frozen date, fidelity and the fixture/recipe. Same seed alone is not a current-state fork.
- Dataset GET returns a recipe descriptor, not an export of all current vendor records. Reset removes injected/client changes; reload fixtures.
- Fault settings are container-wide. Use separate planning/operational containers per vendor, or serialize fault tests.
- Stripe refunds and invoice-balance transactions are implemented. A refund is not a reversible field edit. A negative invoice-balance transaction is not a cash refund.
- Stripe's inspected idempotency fingerprint uses the path and raw request body. Save the exact encoded payload and reuse it on retry.
- Stripe's simulator refund creation hardcodes succeeded. Do not demonstrate settlement/cancellation guarantees from that simplification.
- Zendesk REST supports safe_update + updated_stamp. The simulator's timestamps have one-second precision; different writes can share a stamp.
- Zendesk's MCP comment helper lacks those guard inputs and defaults to public. Use the typed REST adapter and explicit public:false for the core.
- Slack's inspected path accepts client_msg_id but does not deduplicate based on it. Ambiguous post outcomes must not be blindly retried.
- Identical twins may mint identical new Stripe IDs. Force divergence in a test so the remapper is actually exercised.
- era evaluate is documented as an education assignment grader. It is not a verified grader for this executor's authorization and recovery invariants.

Official references: [Era writes](https://console.era.eon.io/docs/allow-writes-in-a-simulator.md), [fidelity](https://console.era.eon.io/docs/how-simulators-differ-from-the-real-products.md), [fixtures](https://console.era.eon.io/docs/load-data-into-a-simulator.md), [faults](https://console.era.eon.io/docs/make-a-simulator-fail-on-purpose.md), [CLI](https://console.era.eon.io/docs/era-cli-commands.md). Public image evidence: [Stripe](https://hub.docker.com/v2/repositories/erabyeon/stripe/tags/latest), [Zendesk](https://hub.docker.com/v2/repositories/erabyeon/zendesk/tags/latest), [Slack](https://hub.docker.com/v2/repositories/erabyeon/slack/tags/latest).

## 3. Locked stack

| Layer | Decision | Reason |
|---|---|---|
| Product language | TypeScript | Share wire schemas across app, planner, execution and evaluation |
| Workspace | pnpm workspaces | One lockfile; no additional build orchestrator needed |
| Runtime | Node 24 line, one exact patch pinned after install smoke | Available locally and satisfies pg-boss current minimum |
| Web | React + Vite, TanStack Query, Tailwind + accessible component primitives | Fast review UI; ordinary deployed Node backend |
| API | Fastify; serve built web app from same origin | Clear REST contracts and simple auth/polling |
| Validation | Zod; derive JSON schemas for tools/API | Runtime validation on every trust boundary |
| Application database | PostgreSQL 17 + Drizzle + pg | Plans, approvals, attempts, policies and queue in one supported database |
| Durable jobs | pg-boss, separate worker entrypoints | No Redis; retries do not live inside HTTP requests |
| Planner | Anthropic TypeScript SDK, explicit bounded tool loop | No shell/browser tools, no general agent framework required |
| Planner model | Start with claude-sonnet-5-5 as currently documented; configurable pinned identity | Account access and task quality still need a small smoke/eval |
| Auth | Clerk React + Fastify/backend integration, patched current SDKs | Reviewer identity and organizations; action authority is ours |
| Simulators | Era Docker images pinned by digest | Reproducible local vendor-shaped APIs |
| Testing | Vitest, Playwright; independent scenario checker | Pure engine tests + real workflow validation |
| Optional memory | SurrealDB Agent Memory through one adapter | Reusable human-approved precedents, not operational state |
| Training/inference | Python 3.12 isolated environment, Qwen3.5-0.8B + LoRA to start | Matches documented environment recipe; behind versioned HTTP/JSON port |
| Deployment | Render API/web + planner worker + executor worker + PG + private simulator services | Always-on jobs and private connectivity |
| Alternative deployment | One controlled Linux VM running Compose | Same code and services if PaaS simulator hosting fails |
| Optional mobile | Expo development build using existing API | No separate business logic or executor |

React/Vite/Fastify/Postgres versions here are design choices, not a claim an exact dependency combination was compiled. Resolve compatible maintained package versions once, lock them, and record pnpm lock + Node patch + Docker digests. Do not continually upgrade during the sprint.

The official Claude overview currently lists Sonnet 5.5 and ID claude-sonnet-5-5. Verify account access through the Models API and one tool-use request; save the returned model identity and prompt/tool schema hashes. Do not use an unpinned “latest” string in benchmark results. [Models](https://platform.claude.com/docs/en/models/overview), [tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview).

pg-boss currently requires Node >=22.12 and Postgres >=13. It provides durable jobs, not exactly-once external financial effects. [Official repository](https://github.com/timgit/pg-boss). PostgreSQL 17 is a conservative supported choice; no newer database feature is required. [Version policy](https://www.postgresql.org/support/versioning/).

Use patched Clerk SDK versions; a published authorization advisory makes separate organization, permission and reverification checks preferable to a clever combined check. [Clerk advisory](https://github.com/clerk/javascript/security/advisories/GHSA-w24r-5266-9c3c).

Do not add Redis, Kafka, Temporal, LangGraph, a graph database, a vector database, a microservice per connector or Kubernetes. None is necessary for this scope.

## 4. Architecture and trust boundaries

The browser sends bounded commands. The API stores intent and returns a run ID. A durable worker does the work.

- **Planner worker:** contains model credentials and only planning-gateway capability. Its tools cannot choose a base URL, tenant, admin path or arbitrary HTTP method.
- **Executor worker:** contains the operational adapter capability, consumes approved immutable manifests, and has no model key or inference dependency in dispatch.
- **Scenario admin:** separate CLI/authenticated operator capability. The planner never receives injection/reset/fault access.
- **Database:** canonical operational truth. Browser events and model statements do not determine authority.
- **Memory/model services:** optional planning/advisory capabilities with no provider mutation credentials.

Use separate entrypoints and secret sets, not one worker process holding every credential. Where the simulator runs open local mode, tenant headers alone are not access control: keep its network private and enforce server-selected routing. A shared PaaS private network is reachability, not isolation; limit exposed tool capabilities and service credentials accordingly.

Core flow:
1. Initialize/verify planning and operational worlds from the same pinned recipe and fixtures.
2. Planner investigates through typed tools; gateway records exactly the allowed evidence it exposed.
3. Compile trace + explicit domain edges into a semantic manifest; validate policy.
4. Reviewer selects/excludes actions; compile a new immutable revision.
5. Server validates current user/org/role/freshness, then stores approval of that exact manifest.
6. Executor revalidates, dispatches in dependency order, journals outcomes and emits receipts.
7. Changed assumptions hold affected work. New executable arguments require a newly approved revision.
8. Optional model prioritizes held cases; optional memory proposes sourced precedents during planning.

## 5. Plan representation and shared contracts

Freeze wire schemas in the first joint session. All four people should then be able to work from the same fixture.

### Mandatory application-owned types

- Money: integer amountMinor plus currency; start CAD only; never floating-point dollars.
- EntityRef: vendor + resource kind + stable source ID.
- ResultRef: step ID + allowlisted result path; used for fork-created output IDs.
- Observation: origin, resource/predicate, semantic projection version, data fingerprint, captured time and completeness.
- QueryObservation: exact supported predicate/parameters, fixed cutoff, all-page completion, sorted matching IDs and relevant projections.
- Action: discriminated domain operation with typed args, dependencies, required role, evidence refs, expected effects and compensation classification.
- PlanManifest: schema version, org/incident/cohort/target, planner/tool/adapter versions, policy manifest, observations and actions.
- ApprovalGrant: plan hash + org + target + actor/session + policy/role requirement + expiry/revocation state.
- Attempt: exact request bytes/hash, operation identity/key, dispatch/admission state, result or uncertainty.
- Receipt: actual observed effect, provider ID/status, approval and evidence references, protection level and unresolved limitations.
- Event: durable monotonically increasing sequence and typed payload.
- ReplayBundle: versioned plan/evidence/policy/perturbation/gold for independent execution and training work.

### Operation vocabulary

Core:
- stripe.refund.create
- zendesk.ticket.patchFields
- zendesk.ticket.appendPrivateNote

Full adds:
- stripe.invoiceBalance.credit
- zendesk.ticket.appendPublicReply
- slack.message.postSummary

Do not allow an arbitrary URL/method or arbitrary JSON patch. Tool implementations add known dependency edges and required observations. The model may explain a decision; it cannot define the only evidence required to validate its own action.

A representative approved action is a 4210-minor-unit refund of a specific charge under a specific obligation. Its dependent note references refundStep.id via a typed ResultRef. At apply, the executor persists the actual returned refund ID. It must not replace all matching strings or reuse the fork's returned ID.

### Canonical hash

Hash validated canonical JSON using an RFC 8785-compatible implementation and SHA-256. Preserve semantic array order; canonicalization sorts object properties, not workflow order. Include selection, action parameters, dependencies, target environment, policy manifest and evidence/projection identities. Exclude presentation-only state.

Any execution-affecting edit makes a new revision/hash. A request to approve must supply expected revision/hash; the server loads its own stored manifest. It never accepts browser-submitted operation bodies as approved truth. [JSON canonicalization](https://www.rfc-editor.org/info/rfc8785/).

Typed approved templates may contain only declared receipt bindings, such as refund ID/status or counted outcomes. Reviewers must see the template and allowed substitutions. No model writes fresh customer-facing text during apply.

### Dependency graph and independent case branches

Use explicit domain/control dependencies, not heuristics based only on repeated IDs:
- a ticket note claiming a refund depends on that refund being confirmed;
- a remedy depends on relevant charge/refund/dispute evidence and the approved obligation;
- a summary depends on branch outcomes and its approved summary rule.

A removed upstream action removes its dependent actions and recompiles affected text before approval.

Keep the original parent plan immutable while running. A held customer's replan is a **new case revision with fresh approval**, not an in-place edit under the old hash. Unaffected original branches may continue only when no shared policy, population, budget or other global invariant became invalid. A new matching customer never silently joins an already approved population.

### Own writes are not external drift

After applying a refund, amount_refunded changes. After patching a ticket, its stamp changes. Comparing every later step to the original frozen snapshot would invalidate the plan's own work.

Maintain an expected-state overlay advanced only by confirmed predecessor receipts. Distinguish baseline observations from reads derived from planned writes. Unexpected collateral changes still cause a hold. Preserve the original observations for audit.

## 6. Execution engine

### State and journal

Run states: planning -> review_ready -> approved -> applying -> completed | partial | held | failed; cancellation becomes effective before the next admitted action.

Attempt states: prepared -> dispatched -> confirmed | rejected | unknown_outcome; with held and compensation_required/conflict/reconciled states where relevant.

Persist intent and exact request bytes/key **before** external dispatch. Commit result/receipt after confirmation. If the process dies between those commits, recover as unknown and reconcile. Do not treat a missing receipt as proof the action did not happen.

Use:
- unique operation identity scoped to org, target, immutable action and obligation;
- one active execution generation/lease per case/run, CAS transitions in PostgreSQL;
- transactionally queued intent or a durable outbox;
- sequential actions inside a customer branch;
- bounded concurrency across independent branches only after the sequential path works.

A local lease limits this application's concurrency. It is not a distributed lock on external Stripe/Zendesk clients.

### Guard order

Before admission:
1. Load stored manifest; verify canonical hash and active approval.
2. Check organization, current relevant authorization/revocation, expiry and policy version.
3. Verify predecessor states and resolve typed result bindings.
4. Re-read supported relevant observations and completely enumerate supported query predicates.
5. Compare current evidence to expected state after own confirmed writes.
6. Validate independent business constraints.
7. Prepare exact request and provider precondition; dispatch.
8. Read back/correlate effect; journal actual outcome.
9. Only then admit dependent communications.

Numeric, predicate and authorization checks are deterministic. Unsupported free-text interpretation remains held until reviewed facts establish its effect. The model may advise which held case to inspect first.

### Phantom detection

Compare the complete matching population, including queries that originally returned zero rows. Record pagination completion, query cutoff/time zone and projection version. Failures, unknown pagination, top-k search or an incomplete first page are not proof of absence.

Demo: a newly injected matching charge changes the customer's incident predicate without changing the old rows. Hold that remedy and dependent note. A nonmatching charge is the control.

Re-running a predicate detects visible changes before admission; it does not prevent a change immediately afterward. Cross-provider serializable isolation is not supplied by this design.

### Provider concurrency and protection labels

For Zendesk, send safe_update:true plus the observed updated_stamp in REST ticket updates. Also compare the relevant current projection. The inspected simulator checks the stamp immediately before its synchronous mutation, but one-second stamps can collide.

Use a capability field such as:
- native_guard_with_documented_limits
- best_effort_reread
- no_atomic_guard

Do not call a timestamp a unique CAS version. A post-write reread can detect a race after harm, not prevent it. In strict production mode, unsupported critical protection should hold rather than be relabeled safe. The hackathon may demonstrate bounded best-effort behavior with the limitation visible.

### Retry and reconciliation

- Stripe: persist idempotency key and exact form encoding, then retry that exact request under supported conditions. Real Stripe v1 caches even some failures; its retention differs from the inspected in-memory simulator.
- Retry definite throttling/transient failures with a bounded policy and Retry-After where supplied.
- Validation, permission and business conflicts are holds/rejections, not endless retries.
- Refund committed but response lost: reconcile through stable operation key and authoritative reads before continuing.
- Notes/public replies/Slack: no assumed exactly-once append guarantee. Persist/correlate markers and returned IDs. Unknown sends remain unknown until evidence resolves them.

Era's built-in faults occur before handlers. For the hard after-commit/lost-response test, add a test transport that forwards the mutation then discards its response. Name this as Rehearsal test infrastructure, not an Era feature.

[Stripe idempotency](https://docs.stripe.com/api/idempotent_requests), [refund API](https://docs.stripe.com/api/refunds/create), [Zendesk collision protection](https://developer.zendesk.com/documentation/ticketing/managing-tickets/creating-and-updating-tickets/#protecting-against-ticket-update-collisions), [Slack post](https://docs.slack.dev/reference/methods/chat.postMessage/).

### Compensation

Do not roll back every successful customer because one branch failed.

A refund that succeeded remains a confirmed refund. A note remains an appended note. A reversing invoice-balance entry is a new accounting action, not erasure.

The hero compensation example is one mutable ticket field, such as priority:
1. Record the before value.
2. Apply the approved change.
3. Another client changes that field.
4. A later action fails.
5. Compensation rereads it; if it no longer equals our written value, preserve the teammate edit and record conflict.

Write only owned fields, not the whole stale ticket object/tag array. Even guarded compensation has the provider's race limitations. Offer manual/proposed compensation when the evidence is insufficient. Do not claim arbitrary automation/notifications are undone.

### Storage

Use ordinary Postgres tables, not an event-sourcing framework:
incidents, runs, plan_versions, observations, query_observations, approval_grants, policy_versions, precedent_registry, step_attempts, step_receipts, object_bindings, run_events, outbox plus pg-boss tables.

Every row is organization-scoped. Plans and original receipts are append-preserved; corrections are new records. This is not proof against a malicious database administrator.

## 7. Full extensions that cannot block the core

### SurrealDB precedents

Core uses a checked-in/versioned policy registry in Postgres. Full adds:
1. A reviewer edits an individual case.
2. A separate finance-authorized “Promote to precedent” action specifies scope, conditions, exceptions and effective dates.
3. Postgres records the approved version and durable outbox.
4. Agent Memory receives the structured precedent; readback validates the stored representation.
5. It becomes active for planning only after successful synchronization.
6. Planner retrieval records returned fact IDs, trace ID and the exact precedent version.
7. Executor checks the deterministic applicable registry version/epoch; it never asks top-k recall whether execution is authorized.

Use a supported entity type such as concept and a stable normalized name; keep knowledge facts separate from instructions. Current docs distinguish attribute supersession from relation validity and may ignore unsupported fields. The brief's generic timestamp assumptions must be tested against actual service readback.

The new-relevant-precedent problem is solved conservatively with a scope epoch/full applicable manifest, not semantic recall completeness. An outage blocks memory-dependent plans; unrelated core plans should still operate.

Required memory gate: publish, recall, trace inspection, replace/read history, demonstrate wrong-scope denial, and show one changed approved precedent holding the dependent plan.

[Structured ingest](https://surrealdb.com/docs/agent-memory/ingest/authoritative/bulk-import), [SDK](https://surrealdb.com/docs/agent-memory/reference/sdk-javascript), [recall](https://surrealdb.com/docs/agent-memory/retrieve/recall), [scopes](https://surrealdb.com/docs/agent-memory/mental-model/contexts-and-scope).

### Actual fine-tuning, independently useful

Keep the real weight-updating experiment. Do not make it an execution-authority dependency.

Versioned request: plan hash/version, policy/planner version, relevant step/evidence, observed change and affected dependency keys. Versioned response: one of likely_unaffected, arguments_changed, step_dropped, new_step_needed, or abstain; evidence refs, model revision and measured/calibrated score when available. No permission or execute flag.

Default implementation always abstains. The core starts and succeeds with that implementation. Advisories prioritize rechecks or prepare explanations/repairs; new executable arguments always need fresh approval.

Training owner starts immediately on ReplayBundle fixtures:
- independent business-validity gold from explicit policy/economic constraints;
- separate same-planner counterfactual behavior labels;
- no-change replay controls and canonical material-effect comparison;
- split by customer and scenario/template family, including unseen planner versions;
- compare rules, prompted untuned small checkpoint, tuned checkpoint and frontier model.

Three planner reruns are behavioral observations, not an independent business oracle. A model that overrides a required stale hold affects safety, regardless of the brief's wording. Track advice false alarms separately from executor false holds.

**Chosen first path:** Qwen/Qwen3.5-0.8B BF16 LoRA in an isolated, pinned environment, after a 32-case update/save/reload test. The observed RTX4070 Laptop has 8GB. Gemma 4 E2B is real but its documented training footprint is tight for this GPU. If hybrid kernels/runtime compatibility consume the timebox, switch to Qwen3-0.6B, not to a larger infrastructure project.

The installed driver advertises CUDA12.7; do not blindly use current install examples targeting CUDA13. Use a separate Python3.12 environment rather than assuming the bundled Python3.14 is the training runtime; this matches the current documented Windows recipe. No driver/package change was performed here. First measure actual compatible execution, peak memory and representative sequence length. [Unsloth Windows setup](https://unsloth.ai/docs/get-started/install/windows-installation).

Save adapter hashes/weights, trainable parameter evidence, logs, base revision, tokenizer, split manifests and paired held-out predictions. Complete the experiment even if the product ships the abstaining baseline. A negative result is legitimate engineering evidence.

Full serving: small Python service with no vendor keys, timeout -> abstain. Test the same saved adapter on target CPU/GPU and measure actual memory/latency. GPU Cloud Run is optional; no event GPU quota or automatic startup-credit grant was verified. A deployed backend cannot call a developer laptop's localhost.

[Qwen model](https://huggingface.co/Qwen/Qwen3.5-0.8B), [Unsloth training](https://unsloth.ai/docs/models/qwen3.5/fine-tune), [Gemma training](https://unsloth.ai/docs/models/gemma-4/train), [CUDA compatibility](https://docs.nvidia.com/deploy/cuda-compatibility/minor-version-compatibility.html), [Cloud Run GPU](https://docs.cloud.google.com/run/docs/configuring/services/gpu).

### Expo

Full adds a thin approver: sign in, inspect exact plan/evidence, approve using the same server API, watch receipts. Native notifications/status are useful only if independently tested. No app-only approval state and no second executor. Start its auth/API shell early after contracts, but finish web first. Development build/signing/physical-device tests are separate gates. [Expo development builds](https://docs.expo.dev/develop/development-builds/introduction/).

## 8. Four-person ownership

Assign by capability rather than arbitrary equal line counts. B should be the strongest backend/distributed-systems person. D should be comfortable with Python/data and independent testing.

| Person | Full-project responsibilities | First independent artifact | Later full-only work |
|---|---|---|---|
| A: integrations + planner | Era bootstrap/pins, typed adapters, fixture loader, recorder, bounded Claude loop, source/predicate observations | ProviderPort fake-compatible adapter + one recorded fixture plan | Credit/public/Slack adapters; memory bridge after core adapters stabilize |
| B: executor + persistence | Database migrations, plan compile/policy/DAG core, canonical hash, journal, guards, remapping, retry/reconciliation/compensation | Execute a hand-authored fixture plan against fake provider; no LLM/UI dependency | Case revision recovery, more action conformance, approval admission hardening |
| C: product + identity + release | Review UI, Fastify commands, Clerk roles/approval flow, receipts, deployment, demo/video | Render fixture diff, exclude dependent action, approve expected hash through API stub | Precedent promotion/history UI; thin Expo client on same API |
| D: quality + ML | Independent gold/scenarios, baseline runner, crash/fault acceptance, actual fine-tuning, scorecard | ReplayBundle + checker + 20 scenarios + always-abstain impact service | LoRA/serving and shadow/advice evaluation |

**D is not exclusively training while integration has no owner.** Their first deliverables are shared fixtures, independent expected results and the model port. GPU jobs can run while they work on conformance/evaluation. Train a small real adapter in parallel, timeboxed; do not spend the week generating thousands of labels while recovery is broken.

A owns memory backend only after its core adapter acceptance passes; C owns its UI. This prevents secretly assigning a fifth owner. If A's core work is late, memory is cut. Expo is C's later extension; if web/release is late, mobile is cut. C does not inherit all backend work.

### Trimmed fallback using the same four people

| Person | Focus after trim decision |
|---|---|
| A | Freeze Stripe refund + Zendesk field/note adapters, fixtures, recorder and real HTTP conformance; no new vendor/resource |
| B | Finish admission, query checks, exact retries, unknown outcomes, remapping and field-conflict demo |
| C | Finish clear web review/receipts, Clerk authorization, deploy, accessible saved replay, video and submission |
| D | Own end-to-end acceptance, independent scorecard and release checks; preserve bounded LoRA experiment/report, remove unstable serving |

Trim removes feature flags, not correctness checks. Keep no-approval refusal, changed-plan refusal, phantom case, exact retry/reconciliation and partial-outcome honesty.

## 9. Parallelization and merge discipline

### First joint session: 60-90 minute contract freeze

All four agree:
1. One incident/policy, core operation kinds, state machine and scope.
2. Contracts v1 and canonicalization rules.
3. Three shared example bundles: happy path, phantom, partial/unknown outcome.
4. ProviderPort, JournalPort, PlannerPort, PrecedentPort and ImpactPort.
5. API request/response fixtures and one event/receipt format.
6. Explicit module/file ownership.

Then branch. Do not let four agents/builders independently invent the run schema.

### What proceeds without waiting

| Work | Starts against | Must not wait for |
|---|---|---|
| UI and approval screens | JSON plans/receipts + MSW or equivalent fake API | Era, model training, executor completion |
| Executor | FakeProvider + fake clock + authored plan | Agent, mobile or live memory |
| Planner/tool loop | Fixture provider emitting real observation schema | Full executor/UI |
| Fine-tuning | ReplayBundle generator + independent gold | Final recorder or entire batch engine |
| Memory adapter | Standalone promotion/recall/readback contract | Model result or Expo |
| Expo shell | Stable approval/read API fixtures | Web polish |
| Deployment | Health/read-only fixture replay | Final model and full scenario set |

Fixtures are development infrastructure. Final integration tests must replace fakes with real Era adapters; fixture success must remain labeled fixture-only.

### Continuous integration

Every branch: typecheck + changed-package tests + schema/fixture validation. Main: same plus core scenario suite. Once Docker CI works, run a small pinned-image conformance suite. Browser smoke covers review/exclude/approve/apply/receipt and permission refusal.

Merge at least daily in small vertical slices; no week-long independent integration branch. Keep contract changes additive; coordinate any breaking schema change with all consumers. The main branch must always run in core mode without memory/model/mobile credentials.

Use one lockfile, versioned migrations and explicit generated fixtures. Do not commit vendor keys, model weights, downloaded third-party implementation layers, private traces or participant credit tokens. Pull pinned public images in setup instead of vendoring their implementation.

## 10. Repository structure

This is the proposed project repository, not the existing research directory:

```text
rehearsal/
  apps/
    web/                         React/Vite review UI (C)
    api/                         Fastify auth/commands/static hosting (C)
    planner-worker/              Claude tool-loop and planning jobs (A)
    executor-worker/             Deterministic execution/recovery jobs (B)
    mobile/                      Expo; full only (C)
    impact-service/              Python serving wrapper; optional (D)
  packages/
    contracts/                   Zod wire types, refs, states, API schemas (joint)
    core/                        Pure plan/DAG/policy/hash/guard logic (B leads)
    providers/                   Typed Stripe/Zendesk/Slack adapters (A)
    db/                          Drizzle schema/migrations/repos/outbox (B)
    planner/                     Tool definitions, prompt versions, trace compiler (A)
    memory/                      Precedent port + Agent Memory adapter (A)
    testkit/                     Fakes, clocks, replay bundles, conformance (D)
  ml/
    data/                        Generators, rubric, split manifests
    train/                       LoRA scripts/configs
    eval/                        Base/tuned/frontier comparison
    manifests/                   Checkpoint/data/template hashes, no weights
  scenarios/
    billing/
      company.recipe.json
      policy.v1.json
      fixtures/
      cases/
      expected/
  evals/
    core/                        Independent workflow scenarios
    providers/                   Pinned-image/native API conformance
    impact/                      Advice metrics, slices, error analysis
  infra/
    compose.yaml                 Separate planning/operational services
    docker/
    render.yaml
  scripts/
    bootstrap/
    smoke/
    seed/
    inject/
    demo/
  docs/
    architecture.md
    capability-matrix.md
    decisions/
    demo.md
    claims-and-limitations.md
  .github/workflows/ci.yml
  .env.example
  pnpm-workspace.yaml
  package.json
  pnpm-lock.yaml
  README.md
```

apps are deployable entrypoints; packages are imported libraries, not mandatory separate services. Keep the monorepo simple: no extra build system needed. If core becomes large, split modules inside the package before inventing more packages.

Expected script names once implementation exists:
pnpm dev, pnpm build, pnpm typecheck, pnpm test:core, pnpm test:providers, pnpm test:e2e, pnpm demo:reset, pnpm demo:phantom, pnpm demo:conflict, pnpm eval:scorecard. These are proposed commands, not scripts created or run in this review.

### API surface

```text
POST /api/incidents/:id/rehearse
GET  /api/runs/:id
GET  /api/plans/:id
POST /api/plans/:id/revisions
POST /api/plans/:id/approvals
POST /api/plans/:id/apply
POST /api/executions/:id/cancel
GET  /api/executions/:id/receipts
GET  /api/runs/:id/events?after=...
```

Every command has request idempotency and expected-version checks. Apply takes a stored plan reference, not arbitrary action JSON. Use authenticated polling first; SSE can replay durable ordered events later. A reconnect never grants permission.

Full adds explicit precedent promotion/read/history endpoints. Injection/fault controls remain a CLI or operator-only allowlisted scenario command, not an arbitrary public admin API.

## 11. Deployment and reproducibility

Local Compose initially has PostgreSQL, Stripe fork/prod and Zendesk fork/prod, plus app/worker entrypoints. Full adds Slack fork/prod and optional inference. Use profile flags for extras. Only public API/web is reachable externally; simulator admin ports stay private/localhost.

Each run records image digests, recipe/fixture hashes, seed/date/state/fidelity, adapter/schema/policy versions and planner/model identity. On baseline initialization, independently compare relevant supported reads across both worlds.

Current inspected amd64 image pins:
- stripe sha256:2fc38cae60b0c330418feb7225c8d70a5fd14a01fe0ce87646e7234a8afe53ad
- zendesk sha256:ae8f43fcaa40941dfd6c75296e5746745538cbf687f9a86ffbbe8e637be4b626
- slack sha256:47bc71e1372f8f94a128d151107147fc242284ab2ed62b732d6e6209f0778cf4

Use corresponding verified architecture images for ARM developers, not an assumed amd64 pin. These are pinned platform manifests inspected on this date, not an endorsement of mutable latest.

Render: API serves web dist; planner/executor are separate background workers; PG and Docker simulators share an allowed private network. Use paid/appropriate always-on service types; do not depend on sleeping/free services for the demo. Configure actual internal origins—laptop localhost will not work from a cloud worker. Prove this on the first thin vertical slice. If private simulator deployment fails, use the controlled Compose VM fallback rather than a public unprotected tunnel. [Private network](https://render.com/docs/private-network), [workers](https://render.com/docs/background-workers).

Render Workflows is a documented alternative with TypeScript support, but not needed. Choose portability and one database, not an outdated claim that Workflows cannot run agents. [Current TypeScript SDK](https://render.com/docs/workflows-sdk-typescript).

Public judges can inspect an actual saved run replay without login. Interactive approvals require authenticated demo roles and fictional isolated data. A replay is labeled a saved execution; do not animate fabricated counters.

## 12. Acceptance and calendar

### First day: actual capability gate

Before large label generation/UI polish:
1. Start pinned writable images and a read-only refusal control.
2. Load recipe/complete fixtures; verify relevant baseline equality and isolation.
3. Create/refetch refund; repeat exact key/bytes and assert one effect.
4. Guard Zendesk update; test stale stamp and same-second limit; confirm explicit private note.
5. Execute one hand-authored approved plan through the journal.
6. Crash after a refund commits but before receipt; recover without a new economic effect.
7. Force fork/apply ID divergence; verify dependent note uses applied ID.

Current Docker daemon absence is an environment setup task, not evidence of failure of the architecture. No simulator was started during this planning review.

### Finite must-pass core suite

Cover at least:
- no approval, wrong org/role, expired/revoked grant, changed hash;
- valid happy path and irrelevant metadata control;
- relevant row edit and full-query phantom, including pagination/empty result;
- own-write overlay without false stale hold;
- upstream exclusion removes dependents;
- different output IDs remap correctly;
- throttling then success with one effect;
- after-commit response loss and process restart;
- partially applied branch without false success message;
- mutable field compensation and preserved conflicting teammate edit;
- unknown append outcome without duplicate note;
- model absent/malformed/timeout cannot alter execution permission;
- concurrent same-second write limitation exposed honestly.

A/B implement unit/adapter behavior; D owns independent expected results and final run evidence. Around20 scenarios is a starting suite, not reliability certification. Keep benign controls so holding every plan cannot appear successful.

Compare the same tasks/evidence/planner under: direct/no-review, per-call approval, and Rehearsal. Count actual reviewer actions separately from hypothetical prompt opportunities. Report invalid allows, wrongful holds, unresolved outcomes, duplicates, confirmed success, review effort, latency and actual token/API use. Model metrics are a separate panel.

### Delivery calendar, Toronto time

| Date | Shared milestone | Full extension work allowed |
|---|---|---|
| Oct18 | Contract v1, 3 bundles, repo/CI skeleton, provider/model/runtime smoke starts | Memory/Expo/ML ports and independent shells |
| Oct19 | One small real plan -> review -> approve -> apply -> receipt, deployed thin slice | Small LoRA update/save/reload; no large dataset yet |
| Oct20 | Phantom, revoked/hash refusal, ID remap, exact refund retry and unknown recovery | Pilot labels/base-vs-tuned path; memory roundtrip; decide retained extensions |
| Oct21 | Teammate-edit conflict, partial effects, baseline scorecard first run | First integrated memory/advice, thin mobile if web stable |
| Oct22 | All core acceptance scenarios; measured demo candidates | Complete stable full extensions only |
| Oct23 evening | Feature freeze; remove incomplete paths/flags from submitted claims | No new dependencies |
| Oct24 | Final independent runs, live deployment smoke, two-minute video, README/Devpost draft | Fix only |
| Oct25 evening | Submit well before cutoff | Buffer |

If behind by Oct20, activate trimmed mode and redirect extension time to release/acceptance. Preserve training artifacts separately; don't spend core delivery time proving a predetermined ML headline.

## 13. Current event facts and resource gates

Submission deadline is Oct25 11:59 PM ET; Devpost displays Oct26 midnight EDT. Make a public two-minute video to satisfy the stricter Luma wording, a public repository and applicable live link, with stack/partner use and prior work/AI-tool disclosure. Top10 demo is Oct29 Toronto; at least one member attends. [Luma](https://luma.com/build-north), [Devpost](https://build-north.devpost.com/), [rules](https://build-north.devpost.com/rules).

Current advertised participant resources:
- Anthropic $100/member, per Luma.
- Free Era early access; authenticated quotas and education approval remain account-specific.
- SurrealDB Agent Memory $50/participant, code BUILDNORTH50.
- Render $50/participant.
- Clerk 50% Pro offer through Georgian.
- Google startup credits require eligibility/application; no automatic GPU entitlement.

Redemption, pooling, expiry, actual balances and account access were not verified. [Official resource list](https://build-north.devpost.com/resources).

The organizer-linked Era PDF could not be read because download is owner-disabled and accessible preview text was unavailable. The SurrealDB Notion pack was not public in this session. Product documentation and public implementation were inspected instead. Do not claim either private pack's instructions/rubric were verified.

No regulator compliance claim is needed to demonstrate this software. Keep the problem story accurate and the deployed prototype's boundaries specific. The next work is implementation of these agreed contracts and the first real vertical slice, not more idea selection.

