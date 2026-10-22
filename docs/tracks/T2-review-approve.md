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

## Decisions

_(add dated entries)_

## Handoff log

_(newest first: date, who, state, open PRs or branches, next step, gotchas)_

- **2026-10-22, Parsa (T2.3).** Branch `t2/T2.3-clerk`, stacked on T2.2. Clerk verifies a bearer session token (`apps/api/src/auth.ts`); the org role maps to our roles per [decision 0004](../decisions/0004-clerk-roles-and-bearer-auth.md). Apply and plan routes now use it, and `GET /api/me` returns the verified identity. The web header shows sign-in, the org switcher and the verified roles; with no `VITE_CLERK_PUBLISHABLE_KEY` it stays read-only on fixtures. **Not done:** the Clerk app itself (roles, org, two demo users) and real keys; nothing has signed in for real yet. **Next:** T2.4 approvals, then wire the review page to `/api/plans`.

- **2026-10-22, Parsa (T2.2).** Branch `t2/T2.2-plans-api`, stacked on T2.1. `apps/api/src/plans.ts`: `GET /api/plans` (latest revision per plan), `GET /api/plans/:id[?revision=n]`, `POST /api/plans/:id/revisions` (`excludeActionIds` + base revision and hash). Every read re-verifies the stored row against its hash. Revisions form a line: building on anything but the latest revision is a 409 `stale_revision`. `storePlan()` is the only writer of revision 1 (for the planner worker or a seed script); the browser never sends manifests. **Next:** T2.3 Clerk, so these routes stop returning 401 to everyone (they use the same `noAuth` placeholder as apply). **Gotchas:** the DB tests only run with `DB_TESTS=1` and a real Postgres (CI has one).

- **2026-10-22, Parsa (T2.1).** Branch `t2/T2.1-plan-diff-view`. The review page renders every bundle in `scenarios/billing/cases/` (picked with `?bundle=`): plan hash, per-customer groups, exact money from minor units, role / reversibility / protection badges, and an evidence drawer listing each cited record and query. Vitest renders all four bundles in CI; the Playwright smoke test (`pnpm --filter @rehearsal/web e2e`) runs locally only. **Next:** T2.2 swaps fixtures for `GET /api/plans/:id`. **Gotchas:** the browser never computes the hash (`@rehearsal/core` needs `node:crypto`); it shows the one the server or fixture file gives it. Playwright uses port 5199; set `PW_CHANNEL=chrome` to skip downloading its Chromium.
