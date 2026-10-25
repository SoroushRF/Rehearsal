# 0011: Two distinct approvers where policy requires it (T2.13)

**Status:** proposed 2026-10-24 (Parsa, T2). This changes executor admission and the approval route, so it needs a reviewer from T3 before it merges.

## Context

[0004](0004-clerk-roles-and-bearer-auth.md) left dual approval out of the trimmed scope; [0009](0009-reopen-full-scope.md) brings it back. Today one grant that holds every role a plan needs is enough. A user with both `support_lead` and `finance_lead` therefore approves a large refund alone, and the approval route refuses a support lead outright for a plan that contains a finance-only step.

## Decision

1. **Policy says when.** A new policy version, v3, adds `dualApprovalMinor` (10000 CAD, the finance threshold). A refund or credit at or above it needs two approvers. Policy v1 and v2 never ask for two, so every existing plan and approval keeps its meaning; a plan opts in by citing v3. The planner keeps citing v1 for now.
2. **What "two" means.** The plan needs two live grants for the same org, revision and hash, from two **different users**: one that holds `support_lead` and one that holds `finance_lead`. One person holding both roles fills one seat, never both. The check is on `actorUserId`, which Clerk verifies; sessions don't count.
3. **Who may sign.** For a plan that needs two approvers, any member holding either role may sign (a support lead can sign a plan that has finance-only steps). The grant records the roles the user held, as today. A second click by the same user returns their live grant, so it can't fill the second seat.
4. **Where it is enforced.**
   - **Executor admission** is the authority. It lists every grant for the plan's hash and refuses unless the two seats are filled by live grants (not revoked, not expired, not dated in the future). Revoking or letting either expire blocks the run. A store that can't list grants refuses (fail closed).
   - **Apply request** and **approval** use the same pure function (`dualApprovalStatus` in `@rehearsal/core`), so the reviewer is told early. Admission re-checks regardless.
   - The run still names one primary grant (`approvalId`, the newest live one), which keeps its own checks.
5. **What the reviewer sees.** `GET /api/plans/:id/approvals` returns, for the latest revision, whether two are needed, who signed in which seat, and which seat is still open. The page shows it beside the Approve button.
6. **No new tables.** Grants are already append-only rows keyed by hash; a second approver is one more row.

## Consequences

- Admission checks once, at the start of a run (and again on a resume), like every other grant check; revoking mid-run is a cancel, not this.
- A small team where one person holds both roles can't approve a large refund alone under v3. That is the point; they stay on v1 or v2.
- Moving the planner to v3 is a separate, deliberate change: then every large refund in the demo takes two sign-ins.
- The refusal matrix grows: one person holding both roles, two people with the same role, a missing seat, a revoked or expired seat, and a stale hash.
- Clerk's fresh-verification step (T2.23) builds on this and stays separate.

## Amendment, 2026-10-25 (T2, reconciling with 0014)

[0014](0014-iam-permission-based-authorization.md) names the two seats as permissions (`rehearsal:approve:support_step`, `rehearsal:approve:finance_step`), not roles, and has IAM judge `run:admit` with a `seats` rule. Two judges would drift, so:

- `dualApprovalStatus` in `@rehearsal/core` is the shared local seat calculation. It judges only the `permissions` stored on grants and reports seats as permission names. A grant with roles but no recorded permissions fills no seat; roles are never mapped back into authority. The API and admission integration already on main uses this permission-based interface; this change preserves it.
- `packages/core/test/approvals-iam.test.ts` runs the T2.13 refusal matrix (one person holding both seats, the same seat twice, a missing, revoked, expired or future-dated seat, a stale hash or revision, another organization, recorded permissions over roles, old rows beside new ones) through both this function and the `run:admit` rule in `scenarios/authz/rehearsal-authz.v1.json`, and they must agree.
- T2.23 (fresh verification) builds on the permission-based `approvalStatus`, not on roles.
- The implementation now on main refuses role-only grants for approval seats. The parity test sends stored grants to IAM unchanged and checks this refusal, including an old row beside a new permission-bearing row.
