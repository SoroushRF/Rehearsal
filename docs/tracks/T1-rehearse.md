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
| T1.5 | Bounded Claude tool loop: pinned model, versioned prompt, step limit, no shell, browser or raw HTTP; planner worker consumes `plan` jobs | M2 | Real plan for the seeded cohort is stored and viewable in T2's UI | #6 | T1.2, T1.4, T1.9, T2.9 |
| T1.6 | ~20 benign and trap tasks, plus baselines (no review; per-call approval counts) for the scorecard | M3–M4 | `pnpm eval:scorecard` prints the comparison table | #7 | T1.5, T4.2 |
| T1.7 | _Stretch:_ Slack summary step (`slack.message.postSummary`) | after M3 | Behind the trim decision | #8 | T1.5 |
| T1.8 | _Stretch:_ SurrealDB precedents (explicit promotion, recall with trace) | after M3 | Behind the trim decision | #9 | T1.5 |
| T1.9 | Signed Era tenant tokens in both workers: mint where the operator holds the admin token, pass to planner and executor workers, refresh before the 1-hour expiry | M2 | Tenant isolation and reset tests pass through the workers' config. **Done:** #46; design in [decision 0002](../decisions/0002-era-tenant-token-minting.md) | #39 | T1.1 |
| T1.10 | Invoice-bound duplicate refunds with a retained paid original | M3 | **Done:** equal distinct invoices and refund cycles refused; excess charges use one original | #61 | — |
| T1.11 | Verify ticket ownership in planning evidence | M3 | **Done:** ticket tools refuse wrong or missing customer links | #63 | — |
| T1.12 | Preserve immutable planning evidence snapshots | M3 | **Done:** changed reads create new snapshots; existing action references retain their assumptions | #73 | — |

## Decisions

- **2026-10-21:** Era tenant tokens are minted by the API (the operator, sole holder of `ERA_ADMIN_TOKEN`). Each worker fetches its own world's token with its own secret and refreshes it 5 min before expiry. Requests fail closed when no valid token is available. See [0002](../decisions/0002-era-tenant-token-minting.md).

## Handoff log

_(newest first: date, who, state, open PRs or branches, next step, gotchas)_

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
