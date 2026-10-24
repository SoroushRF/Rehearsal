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
| T2.7 | Two-minute video script, recording, Devpost page | M4–M5 | Submitted | #16 | T2.6 |
| T2.8 | _Stretch:_ thin Expo approver app on the same API | after M4 | Only if everything else is frozen | #17 | T2.4 |
| T2.9 | Decide currency: align `policy.v1.json` with the Era seed (USD vs CAD) and record it in `docs/decisions/` | M2 | Decision merged; policy and seed agree | #40 | — |
| T2.10 | Rehearse button: start a plan from the review page, follow the planner, show the stored plan | M3 | Planner states and failures in plain words; stored plan selected on arrival | #116 | T1.5 |
| T2.11 | Saved run replay that opens without signing in (part of the T2.5 acceptance) | M4 | `?replay=phantom` is public, read-only and labelled saved; drift test | #118 | — |
| T2.12 | Receipt wording: a confirmed receipt says "Applied", not "read back"; the limitations line says how it was confirmed | M5 | No "read back" claim on write-response confirmations; runs test updated. In review: #133 | #132 | — |
| T2.13 | _Full scope:_ two distinct approvers (support + finance) where policy requires | full scope | Admission refuses until both grants are live and from distinct actors; refusal matrix extended; needs a decision record. **Done:** [0011](../decisions/0011-two-distinct-approvers.md), policy v3, admission, approval and apply routes; the web seats follow | #135 | — |
| T2.14 | _Full scope:_ historical audit view: the exact plan, policy, evidence and grants as approved | full scope | An old run opens with its own plan and policy after the policy changed; test. **Done:** API (`GET /api/runs/:id/audit`, policy snapshot on the grant); the web view follows | #138 | — |
| T2.15 | _Full scope:_ review UI shows the Slack summary step and its exact text | full scope | Plan diff and run timeline render the step, its text and an unresolved post | #145 | T1.17 |
| T2.16 | _Full scope:_ review UI shows the exact rendered public reply being approved | full scope | Excluding the customer drops the reply; uncertain sends shown honestly | #146 | T1.18 |
| T2.17 | _Full scope:_ finance-only "Promote to precedent" route and UI; recalled precedents shown with trace | full scope | Role-checked route plus UI; promotion goes through T1.8's adapter | #147 | T1.8 |
| T2.18 | _Full scope:_ policy chooses a refund or an invoice credit per obligation | full scope | New policy version; a completed remedy blocks a second; UI shows the remedy. **Done:** policy v2 and rules R4/R5 ([0010](../decisions/0010-remedy-policy.md)); the UI part follows once #187 lands | #148 | T1.19 |

## Decisions

_(add dated entries)_

- **2026-10-22:** The demo currency is CAD; the seeded cohort already matches the policy ([0005](../decisions/0005-currency-cad.md)).

## Handoff log

_(newest first: date, who, state, open PRs or branches, next step, gotchas)_

- **2026-10-24, Parsa (T2.14 API).** Branch `t2/T2.14-audit-api`, off `main`. `GET /api/runs/:id/audit` returns the run, its stored plan (re-verified against its hash, evidence inside), the policies as approved, every grant for that hash (who, when, expiry, revoked; the one the run used is marked), and the attempts and receipts, all from stored rows (`source: "stored_history"`). The policy contents come from a new `approval_grants.policies` column, written verbatim at approval time (migration `0004`, additive and nullable; `packages/db` is T3's path, please look). A grant made before the column shows `contents: null`, never today's file. **Not done:** the web view; the DB-backed tests (`DB_TESTS=1`) were not run locally (no Docker), CI runs them. The pure `buildAudit` test with a changed policy does run.

- **2026-10-24, Parsa (T2.13 core + API).** Branch `t2/T2.13-dual-approval`, stacked on `t2/T2.18-remedy-policy` (#188). Policy v3 adds `dualApprovalMinor`; a plan citing it needs live grants from two different users, one `support_lead` and one `finance_lead` (`core/approvals.ts`: `dualApprovalStatus`, `approvalStatus`). **Executor admission** (T3's path, needs your review) lists the grants for the hash (`ApplyStore.loadGrantsForPlanHash`, optional; a store without it refuses a dual plan) and replaces the single-grant role check for such plans. The approval route lets either role sign a dual plan and returns who holds which seat (also on `GET …/approvals`); apply refuses early with the same sentence. API and executor load v1, v2 and v3; the planner still cites v1, so the demo is unchanged. **Not done:** the web seats (next PR); the Postgres-backed tests were not run locally (no Docker), CI runs them. **Gotcha:** the primary `approvalId` on a run is still the newest live grant; admission looks at all grants for the hash.

- **2026-10-24, Parsa (T2.18 policy).** Branch `t2/T2.18-remedy-policy`, off `main`. `policy.v2.json` and `BillingPolicy = V1 | V2` in `core/policy`: a credit is allowed only below `creditMaxMinor` (otherwise refund), a refund and a credit count as one remedy per obligation, and an optional `completedRemedies` map blocks a second remedy (R5). The API and executor worker load v1 and v2 (type-only widening of `policies` in `executor.ts`, `approvals.ts`, `worker.ts`: T3's admission path, please look). **Not done:** feeding `completedRemedies` from stored receipts (T4.10 / T3), and the review UI row for a credit. **Gotcha:** the credit op isn't in `Action` yet, so policy takes a minimal structural `PolicyAction`; decision 0010 is `proposed`, the 10000 limit is an authored demo number.

- **2026-10-24, Parsa (landing page).** Branch `landing-page`, stacked on `UI` (#127), so it merges after that. `/` is now a public, static landing page (no sign-in, no API): what Rehearsal is, the problem, how it works with the two-worlds diagram, three moments (phantom, a teammate's edit survives, a lost response), the guarantees, and an honest "what's real" section. The app moved to `/app`; `/?bundle=…` and `/?replay=…` still work, so shared links don't break (`src/route.ts` decides, with a unit test). The API's navigation fallback already serves `/app`. **Gotchas:** the two statistics (PocketOS, Georgian) are quoted from the project brief and the page says so; check the original sources before leaning on them. Every other claim maps to `AGENTS.md` or a test. Not yet seen on the deployed URL (T2.5).

- **2026-10-24, Parsa (UI pass).** Branch `UI`, UI only: no API, contract or logic changes. A design system (`index.css` tokens, light and dark, self-hosted Inter; `components/ui.tsx` primitives), an app shell, and a redesigned review page: a sticky summary (total, steps, irreversible, sign-off, hash) with the approval panel under it, rows in plain language with a consistent risk legend and a visible "After …" dependency, a progress indicator for Rehearse, a timeline for runs, and the saved replay leading with what happened. Fixed along the way: the floating exclusion bar was pinned to the page, not the screen, by an animation fill (regression test added). axe accessibility checks (WCAG A/AA, light and dark, every live step) caught excluded rows being faded below readable contrast, which is fixed. The browser tests now run against a production build (`vite.e2e.config.ts`) with one retry for a rare page-load abort under parallel load that I couldn't root-cause. **Gotchas:** any new color must be a token, not a raw palette color; `biome.json` now enables Tailwind directives in CSS.

- **2026-10-23, Parsa (T2.11).** Branch `t2/T2.11-saved-replay`, off `main`. `?replay=<id>` opens a saved run from `apps/web/public/replays/<id>.json`: public, read-only, no sign-in and no API call (Clerk isn't even loaded), with a "Saved replay, not live" banner, its evidence label and how it was made. `pnpm replay:build` writes `happy-path` and `phantom` by running the real executor engine on the fake provider (event times come from its test clock, so a rebuild is byte-identical); a test fails if the checked-in files drift. Both are `fixture` evidence. **Next:** an export of a real run (Postgres, after an Era run) into this format, so replays can become `era_integration`; the deployed URL (T2.5) serves these files from `dist/replays`. **Gotcha:** `scripts/replay/` and one line in the root `package.json` are new; no other track's code changed.

- **2026-10-23, Parsa (T2.10).** Branch `t2/T2.10-rehearse-button`, stacked on `fix/105-scope-caches-by-identity` (#115). "Rehearse INC-BILL-0927" calls `POST /api/incidents/:id/rehearse`, polls `GET /api/rehearsals/:id` every 2 s (queued, planning, retrying, stored, failed with the planner's reason), then selects and shows the stored plan. One rehearsal at a time; read-only roles get a clear refusal. The incident ID is a constant in `Rehearse.tsx`, because the API has no incident list. Playwright covers success, failure, retry and refusal against a fake planner API. **Not run against the real planner worker or Claude** (needs the API, Postgres, planner worker and an Anthropic key).

- **2026-10-23, Parsa (#105).** Branch `fix/105-scope-caches-by-identity`. Every cached query on the review page is keyed by the verified user and org (`useTenantKey`), and `IdentityScope` remounts the live page on a new identity and cancels/removes the previous identity's cache, including on sign-out. Playwright switches org and signs out/in against a fake API with slow responses, and asserts no content, grant or editing state from the first identity appears, even while the second loads; both tests fail with the scoping removed. **Gotcha:** any new query that holds tenant data must be keyed through `useTenantKey`. Not tested against a live Clerk session. **Related:** #106 (event cursor) is fixed on the T3 side in #114; the API's `?after=` query needs no change.

- **2026-10-22, Parsa (T2.6).** Branch `t2/T2.6-run-timeline`, stacked on the review-UI branch. API: `GET /api/runs/:id/events?after=<seq>` (run + events, paged at 500) and `GET /api/plans/:id/runs`. Web: after Apply, the run report polls from the last `seq` until the run finishes. It shows one row per action with an outcome badge and a plain sentence (phantom: "New matching record appeared after approval (ch_…)"; teammate conflict: "Not undone: someone changed the field after we wrote it, so their edit was kept"), plus the event log. Earlier runs of the plan can be reopened. **Not done:** a saved run replay that judges can open without signing in (part of T2.5).

- **2026-10-22, Parsa (review UI on the API).** Branch `t2/T2.4-review-ui`, stacked on T2.4. A signed-in reviewer with an org sees that org's stored plans: uncheck actions (dependents drop in the preview) → "Create revision" → banner with dropped actions and the new hash → Approve (refusals explained in plain words) → Apply (shows the run ID). Everyone else still sees the fixtures. `pnpm --filter @rehearsal/api seed:plans <org_id>` stores the four fixture plans for a Clerk org until the planner stores real ones (T1.5 needs to call `storePlan`). Playwright covers the whole flow against a faked API (`e2e/live.html` harness). **Next:** T2.6 run timeline on `GET /api/runs/:id/events`.

- **2026-10-22, Parsa (T2.4).** Branch `t2/T2.4-approvals`, stacked on T2.3. `apps/api/src/approvals.ts`: `POST /api/plans/:id/approvals` (`{revision, planHash}`) stores an `ApprovalGrant` bound to org, revision, hash, user, session and the verified roles, valid for 60 minutes. It refuses what admission would refuse (graph, unknown policy, policy violations, missing roles) plus stale revisions and changed hashes. A repeat click returns the live grant. `GET …/approvals` lists grants with a `live` flag; `POST …/approvals/:grantId/revoke` sets `revokedAt` once. The API loads the same `policy.v1.json` as the executor. **Next:** wire the review page to the API (load, uncheck → new revision, approve), then T2.5 deploy.

- **2026-10-22, Parsa (T2.3).** Branch `t2/T2.3-clerk`, stacked on T2.2. Clerk verifies a bearer session token (`apps/api/src/auth.ts`); the org role maps to our roles per [decision 0004](../decisions/0004-clerk-roles-and-bearer-auth.md). Apply and plan routes now use it, and `GET /api/me` returns the verified identity. The web header shows sign-in, the org switcher and the verified roles; with no `VITE_CLERK_PUBLISHABLE_KEY` it stays read-only on fixtures. **Not done:** the Clerk app itself (roles, org, two demo users) and real keys; nothing has signed in for real yet. **Next:** T2.4 approvals, then wire the review page to `/api/plans`.

- **2026-10-22, Parsa (T2.2).** Branch `t2/T2.2-plans-api`, stacked on T2.1. `apps/api/src/plans.ts`: `GET /api/plans` (latest revision per plan), `GET /api/plans/:id[?revision=n]`, `POST /api/plans/:id/revisions` (`excludeActionIds` + base revision and hash). Every read re-verifies the stored row against its hash. Revisions form a line: building on anything but the latest revision is a 409 `stale_revision`. `storePlan()` is the only writer of revision 1 (for the planner worker or a seed script); the browser never sends manifests. **Next:** T2.3 Clerk, so these routes stop returning 401 to everyone (they use the same `noAuth` placeholder as apply). **Gotchas:** the DB tests only run with `DB_TESTS=1` and a real Postgres (CI has one).

- **2026-10-22, Parsa (T2.1).** Branch `t2/T2.1-plan-diff-view`. The review page renders every bundle in `scenarios/billing/cases/` (picked with `?bundle=`): plan hash, per-customer groups, exact money from minor units, role / reversibility / protection badges, and an evidence drawer listing each cited record and query. Vitest renders all four bundles in CI; the Playwright smoke test (`pnpm --filter @rehearsal/web e2e`) runs locally only. **Next:** T2.2 swaps fixtures for `GET /api/plans/:id`. **Gotchas:** the browser never computes the hash (`@rehearsal/core` needs `node:crypto`); it shows the one the server or fixture file gives it. Playwright uses port 5199; set `PW_CHANNEL=chrome` to skip downloading its Chromium.
