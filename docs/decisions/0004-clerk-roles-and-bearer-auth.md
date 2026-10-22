# 0004: Clerk roles and bearer-only auth (T2.3)

**Status:** accepted 2026-10-22 (Parsa, T2). Please raise objections in team chat or a PR.

## Context

Reviewers sign in with Clerk. A plan needs approval from the roles its actions name (`requiredRole`), and executor admission refuses a grant that lacks any of them. The happy-path plan needs both `support_lead` and `finance_lead`, yet we approve once. Clerk gives each organization membership exactly one role.

## Decision

1. **Roles come from the Clerk organization role**, mapped in `apps/api/src/auth.ts`:
   - `org:finance_lead` → `finance_lead` + `support_lead`. A finance lead can sign everything a support lead can, so one finance approval covers a whole plan.
   - `org:support_lead` → `support_lead`.
   - Any other role (including `org:admin`) → none: the member can read plans but approve nothing.
2. **Everything is org-scoped.** A session without an active organization is unauthenticated for every route.
3. **Only a bearer token counts.** The API verifies `Authorization: Bearer <Clerk session token>` and ignores Clerk's `__session` cookie, so a cross-site form or link can never act as a reviewer. The web app sends the token on every call.
4. **The UI shows roles as the API verified them** (`GET /api/me`), never what the browser assumes.

## Consequences

- Setup: in the Clerk dashboard, create the custom organization roles `finance_lead` and `support_lead` (Clerk prefixes them `org:`), one organization, and two demo users, one per role. Set `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` and `VITE_CLERK_PUBLISHABLE_KEY`; optionally `CLERK_AUTHORIZED_PARTIES` (comma-separated origins).
- Without Clerk keys the API refuses every command (401) and the web app is read-only on fixtures.
- Plans are stored under Clerk's organization ID (`org_…`), so demo plans must be seeded for that ID.
- "Support + finance from distinct users" (full scope) would need a second grant per plan. Not planned for the trimmed scope.
