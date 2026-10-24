# T1 Rehearse: the agent plans in a copy of the company

**Owner:** see the [roster](../../AGENTS.md#roster).

**Demo moment:** a billing bug overcharged customers. The agent investigates Stripe and Zendesk in the planning world and produces a reviewable plan. It never touches the operational world.

**Owns:**
- `infra/compose.yaml`
- `scenarios/billing/` data and fixtures
- `packages/providers` read side (observe, query)
- `packages/planner`
- `apps/planner-worker`
- `evals/` scorecard runner

**Provides to others:**
- Real `Observation` and `QueryObservation` objects. T4 re-runs them at apply time.
- Real `PlanManifest`s that replace the fixtures in T2's UI.
- Seeded worlds plus `demo:reset`.

## Acceptance

- `pnpm smoke:era` is green, and the conformance results are in `docs/capability-matrix.md`.
- The planning and operational worlds start identical for the incident cohort. This is verified by comparing reads.
- The planner produces a manifest that passes `validateGraph` and `evaluateBillingPolicy` for 5–10 customers. It records its model ID, prompt version and tool-schema hash.
- The planner worker refuses to start with operational or admin credentials.

## Tasks

| ID | Task | Milestone | Done when | Issue | Blocked by |
|---|---|---|---|---|---|
| T1.1 | Era day-one gate: writable worlds, refund idempotency, guarded Zendesk update, private note, tenant reset | M1 | Conformance tests pass with `ERA_CONFORMANCE=1`; capability matrix written | #2 | — |
| T1.2 | Seed the incident: 5–10 overcharged customers, plus benign controls, injected identically into both worlds; `pnpm demo:reset` | M1 | Reset → identical worlds every time; fixtures copied from real GET responses. **Done:** #52 | #3 | T1.1, T1.9 |
| T1.3 | Read adapters: get charge, get ticket, and the two query predicates, with full pagination and `complete` set honestly | M1 | Unit tests against recorded responses, plus one live test. **Done:** #49 (`stripeReader`/`zendeskReader` in `packages/providers/src/read.ts`) | #4 | T1.1 |
| T1.4 | Typed planning tools that record evidence and add dependency edges themselves (the model can't define its own evidence) | M2 | A tool call produces observations and actions matching contracts v1. **Done:** `PlanningSession` in `packages/planner/src/tools.ts` | #5 | T1.3 |
| T1.5 | Bounded Claude tool loop: pinned model, versioned prompt, step limit, no shell, browser or raw HTTP; planner worker consumes `plan` jobs | M2 | Real plan for the seeded cohort is stored and viewable in T2's UI. **Done (code):** `runPlanningLoop`, `POST /api/incidents/:id/rehearse`, planner worker; jobs through the API ([0006](../decisions/0006-planner-jobs-through-api.md)). **Live run done 2026-10-24** (Gemini on Vertex via #131: plan stored, approved in the UI, applied 24/24) | #6 | T1.2, T1.4, T1.9, T2.9 |
| T1.6 | ~20 benign and trap tasks, plus baselines (no review; per-call approval counts) for the scorecard | M3–M4 | `pnpm eval:scorecard` prints the comparison table. **Done:** 20 tasks × direct / per-call / Rehearsal on Era with a scripted planner; table in [`evals/scorecard/results/latest.txt`](../../evals/scorecard/results/latest.txt). Model-planner rows not run yet; follow-up is T1.15 | #7 | T1.5, T4.2 |
| T1.7 | _Stretch:_ Slack summary step (`slack.message.postSummary`) | after M3 | Behind the trim decision. **Done:** in `Action`; the planner's `propose_run_summary` adds it last (server-chosen channel, `RUN_SUMMARY_CHANNEL`); the executor posts it after every step and any undo has settled, with counts from those outcomes, and reads a lost post back instead of re-posting; unchecking a step prunes it from the counts. Ran on Era (`evals/providers/test/run-summary.test.ts`) | #8 | T1.5, T1.17, T2.15, T3.10 |
| T1.8 | _Full scope:_ SurrealDB precedents (explicit promotion, recall with trace) | full scope | `PrecedentPort` adapter on SurrealDB Agent Memory passes the memory gate on the hosted service: publish, readback, recall with trace ID, replace and read history, wrong-scope denial, and a changed approved precedent holds the dependent plan ([build-plan §7](../source/build-plan.md#surrealdb-precedents)). **Done:** `packages/memory`: `AgentMemoryPrecedents` (publish with readback, read, history, recall with fact IDs, hit IDs and trace ID) and `checkPrecedentBasis`, which holds a plan from a registry snapshot (superseded, withdrawn, not active, changed, or an area's epoch moved). Gate 6/6 on the hosted service, 3 runs (`MEMORY_GATE=1 pnpm test:memory`; [agent-memory.md](../agent-memory.md), with 7 service surprises). Not here: the Postgres registry and outbox, the promotion route (T2.17), plans carrying citations (contracts) and the executor running the check | #9 | T1.5, T1.16 |
| T1.9 | Signed Era tenant tokens in both workers: mint where the operator holds the admin token, pass to planner and executor workers, refresh before the 1-hour expiry | M2 | Tenant isolation and reset tests pass through the workers' config. **Done:** #46; design in [decision 0002](../decisions/0002-era-tenant-token-minting.md) | #39 | T1.1 |
| T1.10 | Invoice-bound duplicate refunds with a retained paid original | M3 | **Done:** equal distinct invoices and refund cycles refused; excess charges use one original | #61 | — |
| T1.11 | Verify ticket ownership in planning evidence | M3 | **Done:** ticket tools refuse wrong or missing customer links | #63 | — |
| T1.12 | Preserve immutable planning evidence snapshots | M3 | **Done:** changed reads create new snapshots; existing action references retain their assumptions | #73 | — |
| T1.13 | _Full scope:_ public customer reply from an exact approved template (typed op, hashed text) | full scope | Uncertain send reconciled by reading comments, never re-sent blindly; contracts change reviewed by another track | #136 | T1.18, T2.16, T3.11 |
| T1.14 | _Full scope:_ invoice-balance credit as an alternative remedy to a refund | full scope | Era semantics check written up; one remedy per obligation; write, read-back and reconcile on Era | #137 | T1.19, T2.18, T3.12, T4.10, T3.8 |
| T1.15 | _Full scope:_ scorecard rows from a real model planner (T1.6 follow-up) | full scope | `pnpm eval:scorecard` runs with `PLANNER_MODEL=gemini-…`; real-model table in `evals/scorecard/results/` with tokens and evidence level. **Done:** `gemini-4-argon` planned all 20 tasks through `runPlanningLoop` on Era ([`model-gemini-4-argon.txt`](../../evals/scorecard/results/model-gemini-4-argon.txt)): confirmed success direct 2/20, per-call 13/20, Rehearsal 17/20 (scripted: 10/14/18), 0 invalid allows in Rehearsal; 788,708 tokens in 77 requests. Every full plan also tried refunding the USD control, which the tools refused and only direct sent. T9's plan timed out (10 min), so it fails in every mode | #140 | T1.5 |
| T1.16 | _Full scope:_ decision record reopening the trimmed scope (Slack in, SurrealDB allowed, ML out per 0008) | full scope | `docs/decisions/0009-reopen-full-scope.md` merged | #141 | — |
| T1.17 | _Full scope:_ contracts: typed op `slack.message.postSummary` | full scope | Additive contracts change merged; AGENTS.md op list updated. **Done:** `SlackMessagePostSummary` in contracts (approved template, literal and outcome-count bindings, must depend on every step it counts, irreversible), not yet in `Action` (T1.7 adds it). Slack wasn't run on Era here (capability matrix); T3.10 does that | #142 | T1.16 |
| T1.18 | _Full scope:_ contracts: typed op `zendesk.ticket.appendPublicReply` (rendered text in the hash) | full scope | Additive contracts change merged. **Done:** `ZendeskTicketAppendPublicReply` in contracts (exact rendered `body` in the hash, plan literals only, no marker in the approved text), not yet in `Action` (T1.13 adds it); Era check 4/4 in `zendesk-public-reply.test.ts` | #143 | T1.16 |
| T1.19 | _Full scope:_ contracts: typed op `stripe.customer.balanceCredit`, after an Era semantics check | full scope | Capability matrix entry plus additive contracts change merged. **Done:** `StripeCustomerBalanceCredit` in contracts, not yet in `Action` (T1.14 adds it); Era check 6/6 in `stripe-balance-credit.test.ts`. Era doesn't enforce the customer's currency, and the cohort customers are USD while their charges are CAD (capability matrix, surprise 14) | #144 | T1.16 |

### Beyond and benchmark backlog (Oct 24)

See [beyond.md](../beyond.md) for scope, parallel work, external gates and the release cut line. Blockers are completion prerequisites; fixture/contract work may start earlier. Killer rows are optional.

| ID | Task | Milestone | Done when | Issue | Blocked by |
|---|---|---|---|---|---|
| T1.20 | _Beyond:_ Decision record: executable rehearsal and its trust boundaries | M5 | ADR fixes authority, snapshot, isolation and lifecycle boundaries | [#162](https://github.com/SoroushRF/Rehearsal/issues/162) | [T1.16](https://github.com/SoroushRF/Rehearsal/issues/141) |
| T1.21 | _Beyond:_ Contracts: rehearsal jobs, scenario references, and reports | M5 | Additive schemas and fixtures merge without changing existing hashes | [#163](https://github.com/SoroushRF/Rehearsal/issues/163) | [T1.20](https://github.com/SoroushRF/Rehearsal/issues/162) |
| T1.22 | _Beyond:_ Seed disposable Era worlds from a supported incident snapshot | M5 | Supported snapshot recreates matching disposable worlds without touching shared worlds | [#166](https://github.com/SoroushRF/Rehearsal/issues/166) | [T1.21](https://github.com/SoroushRF/Rehearsal/issues/163), [T1.2](https://github.com/SoroushRF/Rehearsal/issues/3), [T1.7](https://github.com/SoroushRF/Rehearsal/issues/8), [T1.13](https://github.com/SoroushRF/Rehearsal/issues/136), [T1.14](https://github.com/SoroushRF/Rehearsal/issues/137) |
| T1.23 | _Beyond:_ Scoped rehearsal credentials and world routing | M5 | Worker accepts only scoped disposable-world credentials and refuses forbidden routes | [#167](https://github.com/SoroushRF/Rehearsal/issues/167) | [T1.20](https://github.com/SoroushRF/Rehearsal/issues/162), [T1.21](https://github.com/SoroushRF/Rehearsal/issues/163), [T1.9](https://github.com/SoroushRF/Rehearsal/issues/39) |
| T1.24 | _Stretch:_ _Killer:_ Native Stripe sandbox setup and read conformance | M5 | Controlled native test reads pass conformance with explicit fidelity limits | [#178](https://github.com/SoroushRF/Rehearsal/issues/178) | [T1.20](https://github.com/SoroushRF/Rehearsal/issues/162), [T1.1](https://github.com/SoroushRF/Rehearsal/issues/2), [T1.3](https://github.com/SoroushRF/Rehearsal/issues/4) |
| T1.25 | _Stretch:_ _Killer:_ Competent scripted benchmark baseline | M5 | Strong scripted workflow runs under identical held-out conditions | [#180](https://github.com/SoroushRF/Rehearsal/issues/180) | [T1.27](https://github.com/SoroushRF/Rehearsal/issues/161), [T4.14](https://github.com/SoroushRF/Rehearsal/issues/179) |
| T1.26 | _Stretch:_ _Killer:_ Precedent reuse across different incidents | M5 | Cross-incident memory/no-memory comparison includes version invalidation | [#181](https://github.com/SoroushRF/Rehearsal/issues/181) | [T1.8](https://github.com/SoroushRF/Rehearsal/issues/9), [T2.17](https://github.com/SoroushRF/Rehearsal/issues/147), [T4.14](https://github.com/SoroushRF/Rehearsal/issues/179) |
| T1.27 | _Benchmark:_ Extend the scorecard to the full operation set | M5 | Full-operation scorecard measures observed effects and omitted obligations | [#161](https://github.com/SoroushRF/Rehearsal/issues/161) | [T1.6](https://github.com/SoroushRF/Rehearsal/issues/7), [T1.15](https://github.com/SoroushRF/Rehearsal/issues/140), [T1.7](https://github.com/SoroushRF/Rehearsal/issues/8), [T1.13](https://github.com/SoroushRF/Rehearsal/issues/136), [T1.14](https://github.com/SoroushRF/Rehearsal/issues/137), [T3.8](https://github.com/SoroushRF/Rehearsal/issues/134) |
| T1.28 | _Benchmark:_ Run and publish versioned benchmark comparisons | M5 | Early full baseline plus frozen-head beyond results support every published metric | [#176](https://github.com/SoroushRF/Rehearsal/issues/176) | [T1.27](https://github.com/SoroushRF/Rehearsal/issues/161), [T4.13](https://github.com/SoroushRF/Rehearsal/issues/175) |

## Decisions

- **2026-10-22:** The planner worker has no database. It takes `plan` jobs and hands back manifests through `/internal/planner/jobs/*` with its own secret; the API checks each manifest against its job before storing revision 1. See [0006](../decisions/0006-planner-jobs-through-api.md).
- **2026-10-21:** Era tenant tokens are minted by the API (the operator, sole holder of `ERA_ADMIN_TOKEN`). Each worker fetches its own world's token with its own secret and refreshes it 5 min before expiry. Requests fail closed when no valid token is available. See [0002](../decisions/0002-era-tenant-token-minting.md).

## Handoff log

- **2026-10-24 (Codex, backlog planning):** Filed 9 owned M5 issues (T1.20 #162, T1.21 #163, T1.22 #166, T1.23 #167, T1.24 #178, T1.25 #180, T1.26 #181, T1.27 #161, T1.28 #176) with scope/track labels, acceptance criteria and linked blockers. Added the cross-track dependency map in [beyond.md](../beyond.md); native GitHub dependencies mirror these rows. No feature implementation or live validation is claimed. Next: finish the full prerequisites, then follow the graph; optional killer work stays off the main release path.

- **2026-10-24 (Codex, Google Cloud funding audit):** Inspected all four accessible billing accounts and all 17 visible project mappings under Soroush's Gmail. All four billing accounts are Closed; large unused grants are scoped to App Builder/Conversations, without verified coverage for direct model inference. Six unclaimed $10 Gen AI & Cloud benefit cards are visible but disabled pending an active billing account. Gemini 4 Argon is a researched alternative, not an implemented or live-tested provider: current worker still constructs Anthropic's client. No paid API calls, billing changes or credit redemptions. Detailed local audit and adapter requirements: `outputs/manual-setup/GCP-CREDITS-AND-WIRING.md`. C: also reached zero free bytes while saving; only about 78 MiB was free at the later check.

_(newest first: date, who, state, open PRs or branches, next step, gotchas)_

- **2026-10-24 (Claude session for the T1 owner):** Gemini planner on Vertex AI, branch `t1/gemini-planner` (draft PR).
  - `apps/planner-worker/src/gemini.ts` puts Gemini behind the loop's `MessagesClient`, so limits, the served-model check, refusal/truncation stops and the deadline are unchanged. Each model turn is replayed from Gemini's own content, so thought signatures round-trip. The worker picks Gemini when `PLANNER_MODEL` starts with `gemini-` (needs `GOOGLE_CLOUD_PROJECT`; ADC). The executor now also refuses Google keys and credential files.
  - Live evidence: `scripts/smoke-gemini.ts`, 2 turns of `gemini-4-argon` over the real planning world: 11 charge reads, then 8 refunds proposed and the USD charge refused by policy; 6,864 input + 1,755 output tokens. Then one full live run through the local stack (Clerk, API :3300, Era worlds): `plan_b15f896d-14fe-4368-8bd6-6148927739c3` r1 planned by `gemini-4-argon`, 8 CAD refunds ($648.77) + 8 priority patches + 8 notes, the 3 trap customers correctly left alone; approved as Finance + Support lead, applied as `run_29f1c649-e066-4971-9735-0c80f6f23de5`, 24/24 done with receipts. Gotcha: each receipt row says both "Applied and read back" and "no read-back yet"; worth a look on T2/T3.
  - Gotchas: the worker uses ADC, so ADC must be signed in as an account with `roles/aiplatform.user` on the project; a different ADC account gives a 403 on `aiplatform.endpoints.predict`. On Windows, stopping a backgrounded `npx tsx` worker can leave its node children running and taking jobs with stale credentials; check for leftover planner processes. A $10/month Vertex AI spend cap (`rehearsal-gemini-cap`) is configured; caps track gross cost and enforce with a delay. C: is nearly full, which makes the full test suite run out of memory.

- **2026-10-24 (Codex, local manual setup for Soroush):** Current `main` at `619c024` is running locally on API/web port 3300, with separate ignored API/planner/executor environment files and an isolated manual tenant. Existing services own ports 3000 and 5432; they were left untouched. Docker control calls time out, so the local database uses an isolated installed Postgres 18.1 cluster on 55432 (the Compose/CI target remains Postgres 17).
  - Verified: all four Era endpoints writable; signed tenant minting; reset/seed with all 11 cases equal; 578 tests with real database integration enabled; 50 Era tests (18 files); 16 Playwright browser tests. The Docker-launched read-only control was excluded because the Docker control API is unavailable.
  - Found a startup failure in `scripts/smoke/apply-e2e.ts`: it imported the removed `fixture` helper. With a local fix, live smoke completed with three receipts, exactly one simulated refund, the ticket patch, and a private note containing the operational refund ID.
  - Branch `fix/manual-setup-smoke`, since split: the smoke fix was opened as #130 but closed as a duplicate of #122 (same fix, opened earlier), the Gemini work is `t1/gemini-planner`. Clerk development credentials are configured, the API/web were rebuilt/restarted, and the explicitly approved finance/support roles are verified in the demo organization's default role set. Own-user registration and the approved finance membership are complete; the real browser session recognizes both application reviewer roles in `Rehearsal Demo`. Anthropic's live Console balance is zero; its sole $100 free-credit entry is marked expired, despite a later grant-confirmation email. An API key and usable credits remain required for the human-operated full-cohort model → review → approve → apply flow. The hackathon organizer directs credit issues to `portfolio+georgian@anthropic.com`; Discord also confirms the one-week expiry and reports refusal to extend expired credits. A local support draft is prepared but not sent. Local setup details/logs are under ignored runtime storage in `outputs/manual-setup/`; no secrets or database files should be committed.

- **2026-10-23 (Claude session for the T1 owner):** Review finding #108 (`fix/108-planner-deadline`).
  - The planner worker's deadline now covers tool calls and finalization:
    - The loop checks the signal before every turn and stops waiting on a tool call once the deadline passes.
    - A plan that finishes after the deadline is reported as `timeout`, not handed back.
    - Each jobs-API call gives up after 30 s.
  - Planning readers get a 30 s per-request `timeoutMs`. It's opt-in on `ReadTarget`, so the executor's guard reads are unchanged.
  - Gotcha: a stalled read is abandoned, not cancelled at the socket. Its own `timeoutMs` is what closes the request.

- **2026-10-23 (Claude session for the T1 owner):** Review finding #107 (`fix/107-plan-completion-hash`, #110).
  - A repeat completion for an already-stored plan is matched on the canonical plan hash, not `JSON.stringify` (JSONB reorders keys). A different manifest under the same plan ID is still refused.
  - Not done: storing the plan and finishing the job are still two steps. The retry path is what recovers.

- **2026-10-22 (Claude session for the T1 owner):** T1.6 scorecard (`t1/T1.6-scorecard-tasks`, `t1/T1.6-scorecard-runner`).
  - `evals/scorecard`: 20 tasks (10 benign controls, 10 traps) with gold end states for all 11 cohort cases; scoring into invalid allows, duplicates, wrongful holds and unresolved outcomes; `pnpm eval:scorecard` runs every task in three modes on Era and writes `results/latest.txt` (the JSON run record is gitignored).
  - Every mode gets the same plan from a scripted rule-following agent (`scripted-rules`, `scorecard-agent.v1`) reading one seeded planning tenant, then its own fresh operational tenant per task, the same drift and the same transport faults.
  - Modes:
    - **direct** sends every intent through the real typed writers, with a fresh key per call, and re-sends the same bytes once after a 429 or a lost response.
    - **per_call** does the same behind a modelled reviewer. The reviewer is diligent: they reject exactly what the planning tools refuse.
    - **rehearsal** stores one approval for the plan hash, then runs `executeRun` with the read guard, restarting up to twice to reconcile.
  - Result on Era (2026-10-22, three identical runs):
    - Confirmed success: Rehearsal 18/20, per-call 14/20, direct 10/20. All three pass the 10 benign controls.
    - Rehearsal had 0 invalid allows and 0 duplicates. Direct had 20 and 4, per-call 11 and 2.
    - Review effort: 37 signatures for Rehearsal against 425 per-call prompts.
    - Cost: Rehearsal's write phase makes about 2× the Era calls (guard reads).
  - **Finding for T4:** Rehearsal's 2 wrongful holds (T3, T10) are refund notes on a ticket whose priority a teammate changed. The note's guard compares the whole ticket row, so the edit that rightly holds the patch also holds the note. The gold was written before the run and says the note should go through.
  - Gotchas:
    - Faults are transport wrappers, not Era's container-wide `/_admin/faults`, so a 429 hits exactly one write.
    - The containers from `pnpm infra:up` without a `.env` use the `.env.example` admin token.
    - The planning reads (about 1,000 per run) are reported separately in the model panel.
  - Not done: a Claude-planner panel. It needs a real model key, and its intents would need replaying per mode.

- **2026-10-22 (Claude session for the T1 owner):** T1.5 tool loop and plan jobs (`t1/T1.5-tool-loop`).
  - `runPlanningLoop` (`packages/planner/src/loop.ts`) runs a manual Messages API loop with the 7 planning tools only, `SYSTEM_PROMPT` and `PROMPT_VERSION` (`billing-remedy.v1+<hash of prompt and limits>`), and limits of 40 turns, 200 tool calls and 16k tokens per turn. The model is pinned (`PLANNER_MODEL`, default `claude-sonnet-5-5`); a reply from any other model fails the run. Refusal, truncation, limits, an empty plan or an invalid graph all fail closed. Nothing partial is stored.
  - The brief (`incidentBrief`) lists only who reported the incident. The agent has to find the duplicates and the controls itself.
  - API: `POST /api/incidents/:id/rehearse` queues a `plan` job (reviewer with a role only) and `GET /api/rehearsals/:id` shows queued, planning, retrying, failed or stored. The worker talks to the API through `/internal/planner/jobs/{next,complete,fail}`. `DATABASE_URL` is now forbidden in the planner worker.
  - The worker reads its own `.env.planner` (see `.env.example`), because the shared `.env` holds credentials it refuses.
  - Evidence:
    - `fixture`: loop tests with a scripted model, and worker tests.
    - Real Postgres: `DB_TESTS=1` for the rehearse routes.
    - Real Era (2026-10-22), with a rule-following scripted model in place of Claude: the real worker code read the seeded planning world and stored a 24-step plan through the real API (8 CAD refunds of the c01–c08 `…b` charges, 8 priority patches, 8 notes). The USD control was refused by policy, the hash recomputes, and graph and policy are clean.
    - `pnpm --filter @rehearsal/planner-worker start` with a dummy key reached the Anthropic API, got a 401 and reported it on the job as `planner_error`.
  - **Not done:** a run with a real `ANTHROPIC_API_KEY`; there was none on this machine. To do it: `pnpm infra:up`, `pnpm demo:reset`, start the API with `.env`, start the worker with `.env.planner`, then `POST /api/incidents/INC-BILL-0927/rehearse` as a signed-in reviewer. The plan shows up in T2's plan list.
  - Gotchas:
    - There is no Rehearse button in the web UI yet (T2 territory).
    - Repeated rehearse requests queue repeated runs.
    - A failed run retries once after 30 s, even for a 401.
    - On real Era, requesters also have baseline tickets, so the ticket whose `external_id` is the customer's is the one to use (the prompt says so).

- **2026-10-22 (Claude session for the T1 owner):** T1.4 planning tools (`t1/T1.4-planning-tools`).
  - `PlanningSession` takes the two planning-world readers, the policy and the incident window. `call(name, input)` validates strict Zod input and returns `{ok, result | error}` for the tool loop to feed back. `planningToolDefinitions()` is the Anthropic `tools` array; `TOOL_SCHEMA_HASH` goes into the manifest.
  - Tools: `get_charge`, `list_customer_charges` (the window is the incident's, not the model's), `get_ticket`, `list_requester_tickets`, `propose_duplicate_refund`, `propose_ticket_priority`, `propose_refund_note`.
  - The propose tools re-read what they depend on and set evidence, query evidence, role (finance at ≥ 10000 minor), compensation, protection, obligation (one per duplicate pair) and the note's `dependsOn` + `ResultRef`. The model supplies IDs and a rationale only.
  - They refuse the three controls (distinct amounts, USD, outside the window), a second remedy for the same pair, and ticket steps for a customer with no refund.
  - `session.manifest(meta)` builds revision 1. Live check: `evals/providers/test/planning-tools.test.ts` plans all 8 duplicates and passes `validateGraph` and `evaluateBillingPolicy`.
  - Next (T1.5): the loop maps Claude `tool_use` blocks onto `session.call` and stores `session.manifest`. Readers come from `workerWorlds("planner")`.

- **2026-10-22 (Claude session for the T1 owner):** T1.2 merged (#52).
  - The cohort is in `scenarios/billing/incident.v1.json`: 8 duplicates and 3 controls. `incidentRecords()` in testkit builds the inject records from the verbatim GET templates.
  - `pnpm demo:reset` resets, seeds all four worlds and compares planning against operational.
  - IDs: charges are `ch_INC0927<key>{a,b}`, and for a duplicate, `b` is the one to refund. Tickets are `9100001`–`9100011`, each with `external_id` set to the Stripe customer ID. Requesters are seeded end users `2000020`–`2000030`. Zendesk user IDs aren't contiguous (2000011 doesn't exist), so check before changing them.
  - Charges are CAD, which settles capability-matrix surprise 12 for the cohort.
  - Not done: T4's `scripts/inject/session.ts` `SEED` still points at the image-seed customer. The phantom and conflict scripts could switch to a cohort case.

- **2026-10-22 (Claude session for the T1 owner):** T1.3 read adapters merged (#49).
  - Projections: `stripe.charge.v1` is id, customer, amount, amount_refunded, currency and status. `zendesk.ticket.v1` is id, priority, status and requester_id; IDs are strings and comments are excluded (capability matrix #8).
  - The Stripe query sends the window to the server and also filters on the client. Zendesk uses `/users/{id}/tickets/requested.json`, follows `next_page` only on the world's own origin, and checks `count`.
  - `complete` is false on any failed page, stuck cursor, foreign next link, count mismatch or page cap (50).
  - `cutoff` is recorded, not used as a filter: the predicate's window bounds membership, so a phantom injected later with an in-window `created` is still found.
  - Recorded responses are in `packages/providers/test/recorded/`. The live test is `evals/providers/test/read-adapters.test.ts`.

- **2026-10-21 (Claude session for the T1 owner):** T1.9 merged (#46, closes #39). It touches credentials, so a post-merge review from another track is still welcome.
  - Workers get worlds from `workerWorlds("planner" | "executor")` in `@rehearsal/providers`. T1.5 and T3.3 should take worlds from there, never from `resolveWorld`.
  - To run a worker you now need the API up, with `ERA_ADMIN_TOKEN` and both worker secrets set. The worker itself gets only `REHEARSAL_API_URL` and its own secret.
  - Gotcha: `pnpm dev`/`.env` loads every variable into the API. Never start a worker with the full `.env`: its startup check refuses the other worker's secret and the admin token.
  - Live check: `evals/providers/test/worker-tenancy.test.ts` (`ERA_CONFORMANCE=1`).
