# T2 Review & Approve: one informed approval of an exact plan

**Owner:** see the [roster](../../AGENTS.md#roster).

**Demo moment:** the reviewer sees the whole job grouped by customer, with money, reversibility, protection level and evidence. Unchecking a customer drops their dependent note. Refunds over the threshold need the finance lead. The reviewer approves once, and that approval binds to the plan hash.

**Owns:**
- `apps/web`
- `apps/api` plan, revision and approval routes, and auth
- Clerk integration
- `packages/core/src/policy.ts`
- Deployment (Render, or the Compose VM fallback)
- Video and Devpost

**Provides to others:**
- Stored `ApprovalGrant`s that T3 checks at admission.
- Run, receipt and hold views for every track's demo moment.

## Acceptance

- The UI renders every fixture bundle in `scenarios/billing/cases/`. It shows the plan hash, a reversibility and protection label per action, and the evidence behind each action.
- Excluding an action creates a new revision through the API. The UI shows which dependents dropped and the new hash.
- Approval is refused for each of these, with a test per case: not signed in, wrong organization, missing finance role above the threshold, stale revision or hash, expired grant, revoked grant.
- The deployed URL works. Judges can open a saved run replay without logging in, and the replay is clearly labelled as saved.

## Tasks

| ID | Task | Milestone | Done when | Issue | Blocked by |
|---|---|---|---|---|---|
| T2.1 | Plan diff view from fixture bundles: per-customer groups, money formatting, labels, evidence drawer, plan hash | M1 | All four bundles render; Playwright smoke test | #10 | — |
| T2.2 | API: store plans; `GET /api/plans/:id`; `POST /api/plans/:id/revisions` (uses `excludeActions`) with expected-hash check | M1–M2 | Excluding `refund_001` returns revision 2 without `note_001` | #11 | T3.1 |
| T2.3 | Clerk sign-in, `support_lead` / `finance_lead` roles, and server-side checks | M2 | Two demo users; role shown in the UI | #12 | — |
| T2.4 | `POST /api/plans/:id/approvals`: grant bound to org, revision, hash, actor and expiry; full refusal test matrix | M2 | Refusal tests green; grant visible to T3 | #13 | T2.2, T2.3 |
| T2.5 | Deploy thin slice: API + web, workers, Postgres, private simulators. Prove the cloud workers can reach the simulators. | M2 | Public URL plus a smoke script; the fallback is decided if this fails | #14 | T2.2, T1.5, T3.2 |
| T2.6 | Run timeline, receipts and held-step views (polling `GET /api/runs/:id/events`) | M3 | Phantom and conflict runs read clearly to a stranger | #15 | T3.2 |
| T2.7 | Two-minute video script, recording, Devpost page | M4–M5 | Final integration gate and frozen-head benchmark evidence used in video/Devpost; submitted | #16 | [T2.6](https://github.com/SoroushRF/Rehearsal/issues/15), [T2.5](https://github.com/SoroushRF/Rehearsal/issues/14), [T1.28](https://github.com/SoroushRF/Rehearsal/issues/176) |
| T2.8 | _Stretch:_ thin Expo approver app on the same API | after M4 | Only if everything else is frozen | #17 | T2.4 |
| T2.9 | Decide currency: align `policy.v1.json` with the Era seed (USD vs CAD) and record it in `docs/decisions/` | M2 | Decision merged; policy and seed agree | #40 | — |
| T2.10 | Rehearse button: start a plan from the review page, follow the planner, show the stored plan | M3 | Planner states and failures in plain words; stored plan selected on arrival | #116 | T1.5 |
| T2.11 | Saved run replay that opens without signing in (part of the T2.5 acceptance) | M4 | `?replay=phantom` is public, read-only and labelled saved; drift test | #118 | — |
| T2.12 | Receipt wording: a confirmed receipt says "Applied", not "read back"; the limitations line says how it was confirmed | M5 | No "read back" claim on write-response confirmations; runs test updated. In review: #133 | #132 | — |
| T2.13 | _Full scope:_ two distinct approvers (support + finance) where policy requires | full scope | Admission refuses until both grants are live and from distinct actors; refusal matrix extended; needs a decision record | #135 | — |
| T2.14 | _Full scope:_ historical audit view: the exact plan, policy, evidence and grants as approved | full scope | An old run opens with its own plan and policy after the policy changed; test | #138 | — |
| T2.15 | _Full scope:_ review UI shows the Slack summary step and its exact text | full scope | Plan diff and run timeline render the step, its text and an unresolved post | #145 | T1.17 |
| T2.16 | _Full scope:_ review UI shows the exact rendered public reply being approved | full scope | Excluding the customer drops the reply; uncertain sends shown honestly | #146 | T1.18 |
| T2.17 | _Full scope:_ finance-only "Promote to precedent" route and UI; recalled precedents shown with trace | full scope | Role-checked route plus UI; promotion goes through T1.8's adapter | #147 | T1.8 |
| T2.18 | _Full scope:_ policy chooses a refund or an invoice credit per obligation | full scope | New policy version; a completed remedy blocks a second; UI shows the remedy | #148 | T1.19 |

### Beyond and benchmark backlog (Oct 24)

See [beyond.md](../beyond.md) for scope, parallel work, external gates and the release cut line. Blockers are completion prerequisites; fixture/contract work may start earlier. Killer rows are optional.

| ID | Task | Milestone | Done when | Issue | Blocked by |
|---|---|---|---|---|---|
| T2.19 | _Beyond:_ API: request and read an execution rehearsal | M5 | Authorized idempotent endpoints queue stored references and expose scoped reports | [#171](https://github.com/SoroushRF/Rehearsal/issues/171) | [T1.21](https://github.com/SoroushRF/Rehearsal/issues/163), [T3.13](https://github.com/SoroushRF/Rehearsal/issues/164), [T2.14](https://github.com/SoroushRF/Rehearsal/issues/138) |
| T2.20 | _Beyond:_ Review UI: start a rehearsal and follow its progress | M5 | Reviewer starts one scoped job and follows progress without granting apply | [#172](https://github.com/SoroushRF/Rehearsal/issues/172) | [T2.19](https://github.com/SoroushRF/Rehearsal/issues/171) |
| T2.21 | _Beyond:_ Review UI: compare expected and observed rehearsal outcomes | M5 | Expected/observed report shows discrepancies, uncertainty and stale revisions | [#174](https://github.com/SoroushRF/Rehearsal/issues/174) | [T2.19](https://github.com/SoroushRF/Rehearsal/issues/171), [T4.12](https://github.com/SoroushRF/Rehearsal/issues/173) |
| T2.22 | _Beyond:_ Operator task tests and findings | M5 | Two outside operators complete observed tasks; findings and limits are recorded | [#177](https://github.com/SoroushRF/Rehearsal/issues/177) | [T2.5](https://github.com/SoroushRF/Rehearsal/issues/14), [T2.6](https://github.com/SoroushRF/Rehearsal/issues/15) |
| T2.23 | _Stretch:_ _Killer:_ Server-side fresh verification bound to the plan | M5 | Fresh verified session authorizes only one exact approval intent | [#182](https://github.com/SoroushRF/Rehearsal/issues/182) | [T2.13](https://github.com/SoroushRF/Rehearsal/issues/135), [T2.4](https://github.com/SoroushRF/Rehearsal/issues/13) |
| T2.24 | _Stretch:_ _Killer:_ Clerk verification UI | M5 | Real verification UI preserves reviewed intent through cancel/stale/retry paths | [#183](https://github.com/SoroushRF/Rehearsal/issues/183) | [T2.23](https://github.com/SoroushRF/Rehearsal/issues/182), [T2.3](https://github.com/SoroushRF/Rehearsal/issues/12) |

## Decisions

_(add dated entries)_

- **2026-10-22:** The demo currency is CAD; the seeded cohort already matches the policy ([0005](../decisions/0005-currency-cad.md)).

## Handoff log

- **2026-10-24 (Codex, backlog planning):** Filed 6 owned M5 issues (T2.19 #171, T2.20 #172, T2.21 #174, T2.22 #177, T2.23 #182, T2.24 #183) with scope/track labels, acceptance criteria and linked blockers. Added the cross-track dependency map in [beyond.md](../beyond.md); native GitHub dependencies mirror these rows. No feature implementation or live validation is claimed. Next: finish the full prerequisites, then follow the graph; optional killer work stays off the main release path.

_(newest first: date, who, state, open PRs or branches, next step, gotchas)_

- **2026-10-23, Parsa (T2.11).** Branch `t2/T2.11-saved-replay`, off `main`. `?replay=<id>` opens a saved run from `apps/web/public/replays/<id>.json`: public, read-only, no sign-in and no API call (Clerk isn't even loaded), with a "Saved replay, not live" banner, its evidence label and how it was made. `pnpm replay:build` writes `happy-path` and `phantom` by running the real executor engine on the fake provider (event times come from its test clock, so a rebuild is byte-identical); a test fails if the checked-in files drift. Both are `fixture` evidence. **Next:** an export of a real run (Postgres, after an Era run) into this format, so replays can become `era_integration`; the deployed URL (T2.5) serves these files from `dist/replays`. **Gotcha:** `scripts/replay/` and one line in the root `package.json` are new; no other track's code changed.

- **2026-10-23, Parsa (T2.10).** Branch `t2/T2.10-rehearse-button`, stacked on `fix/105-scope-caches-by-identity` (#115). "Rehearse INC-BILL-0927" calls `POST /api/incidents/:id/rehearse`, polls `GET /api/rehearsals/:id` every 2 s (queued, planning, retrying, stored, failed with the planner's reason), then selects and shows the stored plan. One rehearsal at a time; read-only roles get a clear refusal. The incident ID is a constant in `Rehearse.tsx`, because the API has no incident list. Playwright covers success, failure, retry and refusal against a fake planner API. **Not run against the real planner worker or Claude** (needs the API, Postgres, planner worker and an Anthropic key).

- **2026-10-23, Parsa (#105).** Branch `fix/105-scope-caches-by-identity`. Every cached query on the review page is keyed by the verified user and org (`useTenantKey`), and `IdentityScope` remounts the live page on a new identity and cancels/removes the previous identity's cache, including on sign-out. Playwright switches org and signs out/in against a fake API with slow responses, and asserts no content, grant or editing state from the first identity appears, even while the second loads; both tests fail with the scoping removed. **Gotcha:** any new query that holds tenant data must be keyed through `useTenantKey`. Not tested against a live Clerk session. **Related:** #106 (event cursor) is fixed on the T3 side in #114; the API's `?after=` query needs no change.

- **2026-10-22, Parsa (T2.6).** Branch `t2/T2.6-run-timeline`, stacked on the review-UI branch. API: `GET /api/runs/:id/events?after=<seq>` (run + events, paged at 500) and `GET /api/plans/:id/runs`. Web: after Apply, the run report polls from the last `seq` until the run finishes. It shows one row per action with an outcome badge and a plain sentence (phantom: "New matching record appeared after approval (ch_…)"; teammate conflict: "Not undone: someone changed the field after we wrote it, so their edit was kept"), plus the event log. Earlier runs of the plan can be reopened. **Not done:** a saved run replay that judges can open without signing in (part of T2.5).

- **2026-10-22, Parsa (review UI on the API).** Branch `t2/T2.4-review-ui`, stacked on T2.4. A signed-in reviewer with an org sees that org's stored plans: uncheck actions (dependents drop in the preview) → "Create revision" → banner with dropped actions and the new hash → Approve (refusals explained in plain words) → Apply (shows the run ID). Everyone else still sees the fixtures. `pnpm --filter @rehearsal/api seed:plans <org_id>` stores the four fixture plans for a Clerk org until the planner stores real ones (T1.5 needs to call `storePlan`). Playwright covers the whole flow against a faked API (`e2e/live.html` harness). **Next:** T2.6 run timeline on `GET /api/runs/:id/events`.

- **2026-10-22, Parsa (T2.4).** Branch `t2/T2.4-approvals`, stacked on T2.3. `apps/api/src/approvals.ts`: `POST /api/plans/:id/approvals` (`{revision, planHash}`) stores an `ApprovalGrant` bound to org, revision, hash, user, session and the verified roles, valid for 60 minutes. It refuses what admission would refuse (graph, unknown policy, policy violations, missing roles) plus stale revisions and changed hashes. A repeat click returns the live grant. `GET …/approvals` lists grants with a `live` flag; `POST …/approvals/:grantId/revoke` sets `revokedAt` once. The API loads the same `policy.v1.json` as the executor. **Next:** wire the review page to the API (load, uncheck → new revision, approve), then T2.5 deploy.

- **2026-10-22, Parsa (T2.3).** Branch `t2/T2.3-clerk`, stacked on T2.2. Clerk verifies a bearer session token (`apps/api/src/auth.ts`); the org role maps to our roles per [decision 0004](../decisions/0004-clerk-roles-and-bearer-auth.md). Apply and plan routes now use it, and `GET /api/me` returns the verified identity. The web header shows sign-in, the org switcher and the verified roles; with no `VITE_CLERK_PUBLISHABLE_KEY` it stays read-only on fixtures. **Not done:** the Clerk app itself (roles, org, two demo users) and real keys; nothing has signed in for real yet. **Next:** T2.4 approvals, then wire the review page to `/api/plans`.

- **2026-10-22, Parsa (T2.2).** Branch `t2/T2.2-plans-api`, stacked on T2.1. `apps/api/src/plans.ts`: `GET /api/plans` (latest revision per plan), `GET /api/plans/:id[?revision=n]`, `POST /api/plans/:id/revisions` (`excludeActionIds` + base revision and hash). Every read re-verifies the stored row against its hash. Revisions form a line: building on anything but the latest revision is a 409 `stale_revision`. `storePlan()` is the only writer of revision 1 (for the planner worker or a seed script); the browser never sends manifests. **Next:** T2.3 Clerk, so these routes stop returning 401 to everyone (they use the same `noAuth` placeholder as apply). **Gotchas:** the DB tests only run with `DB_TESTS=1` and a real Postgres (CI has one).

- **2026-10-22, Parsa (T2.1).** Branch `t2/T2.1-plan-diff-view`. The review page renders every bundle in `scenarios/billing/cases/` (picked with `?bundle=`): plan hash, per-customer groups, exact money from minor units, role / reversibility / protection badges, and an evidence drawer listing each cited record and query. Vitest renders all four bundles in CI; the Playwright smoke test (`pnpm --filter @rehearsal/web e2e`) runs locally only. **Next:** T2.2 swaps fixtures for `GET /api/plans/:id`. **Gotchas:** the browser never computes the hash (`@rehearsal/core` needs `node:crypto`); it shows the one the server or fixture file gives it. Playwright uses port 5199; set `PW_CHANNEL=chrome` to skip downloading its Chromium.
