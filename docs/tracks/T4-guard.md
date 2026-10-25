# T4 Guard: catch what changed, preserve what others did

**Owner:** see the [roster](../../AGENTS.md#roster). The ML tasks run on the GPU machine.

**Demo moments:**
- **Phantom:** after approval, a new duplicate charge appears for a customer. Re-running that customer's query catches it, and the refund and its note are held.
- **Teammate conflict:** a teammate changes a ticket's priority mid-apply, then a later step fails. The undo sees the teammate's value and preserves it, recording a conflict.

**Owns:**
- Guard functions in `packages/core`: observation re-check, query-membership diff, own-write tracking
- Compensation logic
- `scripts/inject/` and the `demo:*` scripts
- `ml/`, the impact model behind `ImpactPort`

**Provides to others:**
- Pure guard functions that T3 calls at admission.
- Injection scripts for T1's traps and T2's demo.

## Acceptance

- **Phantom:** the `phantom` bundle passes on Era. A control case, where the injected charge doesn't match, still applies.
- **Conflict:** the `teammate-conflict` bundle passes on Era. The teammate's value survives and a `compensation_conflict` receipt is recorded.
- **Own writes:** a later step after our own refund or patch doesn't trip a false stale hold.
- **No false proof of absence:** a failed query, a partial query or an unknown pagination state holds the step.
- **Model never gates:** if the impact model is missing, malformed or times out, execution permission doesn't change.

## Tasks

| ID | Task | Milestone | Done when | Issue | Blocked by |
|---|---|---|---|---|---|
| T4.1 | Pure guards: observation projection compare, query-membership diff (added/removed, empty results count), own-write overlay advanced only by confirmed receipts | M1 | Unit tests on fixture observations | #25 | — |
| T4.2 | Injection scripts: phantom charge, teammate field edit, Era faults, reset. Exposed as `pnpm demo:phantom` / `demo:conflict` / `demo:reset`. | M2 | Scripts run against local worlds | #26 | — |
| T4.3 | Wire guards into T3's admission; hold reasons in receipts; dependents skipped | M2–M3 | `phantom` bundle passes on Era. **Done:** `evals/providers/test/phantom.test.ts` | #27 | T4.1, T4.2, T3.2, T1.3, T3.3, T1.9 |
| T4.4 | Conditional compensation on owned fields: re-read, revert only if our value is still there, otherwise record a conflict | M3 | `teammate-conflict` bundle passes on Era. **Done:** `evals/providers/test/compensation.test.ts` | #28 | T4.3, T3.3 |
| T4.5 | _Stretch:_ ML smoke test: Qwen3.5-0.8B LoRA on 32 cases. Deferred past the hackathon ([0008](../decisions/0008-ml-out-of-hackathon-scope.md)) | — | Smoke log + adapter hash in `ml/manifests/` | #29 | — |
| T4.6 | _Stretch:_ ML pilot: base vs. tuned vs. rules vs. zero-shot, then go/no-go. Deferred past the hackathon ([0008](../decisions/0008-ml-out-of-hackathon-scope.md)) | — | Report in `evals/impact/`; decision recorded | #30 | — |
| T4.7 | _Stretch:_ impact service behind `ImpactPort`, advisory only. Deferred past the hackathon ([0008](../decisions/0008-ml-out-of-hackathon-scope.md)) | — | Integration test: model absent or failing → same execution | #31 | — |
| T4.10 | _Full scope:_ guard: one remedy per obligation across refunds and credits | Done | A second remedy for the same obligation is held, including a teammate's and one sent under another plan or revision; distinct obligations pass. Fixture: `apps/executor-worker/test/one-remedy.test.ts`. Era: `evals/providers/test/one-remedy.test.ts` passes | #152 | T1.19 |

### IAM authorization (Oct 24)

Decision [0014](../decisions/0014-iam-permission-based-authorization.md) is proposed. These rows are the implementation. T4.15 stays open until that record merges.

| ID | Task | Milestone | Done when | Issue | Blocked by |
|---|---|---|---|---|---|
| T4.15 | Decision 0014: IAM as the permission decision point | M5 | The decision records permissions, the IAM service, and who may call it | [#220](https://github.com/SoroushRF/Rehearsal/issues/220) | — |
| T4.16 | Contracts: permissions, rule file, IAM request and response | M5 | Shared types parse, and a grant can carry permissions and a rule version | [#221](https://github.com/SoroushRF/Rehearsal/issues/221) | [T4.15](https://github.com/SoroushRF/Rehearsal/issues/220) |
| T4.17 | Rule file v1 | M5 | Versioned JSON maps the four roles and covers every person-facing route plus `run:admit` | [#222](https://github.com/SoroushRF/Rehearsal/issues/222) | [T4.16](https://github.com/SoroushRF/Rehearsal/issues/221) |
| T4.18 | Pure PDP engine | M5 | A pure function allows or denies from the rule file, and denies when the rule is missing | [#223](https://github.com/SoroushRF/Rehearsal/issues/223) | [T4.16](https://github.com/SoroushRF/Rehearsal/issues/221) |
| T4.19 | IAM service | M5 | The service checks a Clerk token or stored grants over mTLS and fails closed | [#224](https://github.com/SoroushRF/Rehearsal/issues/224) | [T4.17](https://github.com/SoroushRF/Rehearsal/issues/222), [T4.18](https://github.com/SoroushRF/Rehearsal/issues/223) |
| T4.20 | API enforcement | M5 | Person-facing routes ask IAM with facts taken from stored rows | [#225](https://github.com/SoroushRF/Rehearsal/issues/225) | [T4.19](https://github.com/SoroushRF/Rehearsal/issues/224) |
| T4.21 | Grants store permissions | M5 | New grants record permissions and the rule version; a role-only row is not a silent allow | [#226](https://github.com/SoroushRF/Rehearsal/issues/226) | [T4.16](https://github.com/SoroushRF/Rehearsal/issues/221), [T4.20](https://github.com/SoroushRF/Rehearsal/issues/225) |
| T4.22 | Executor `run:admit` | M5 | Admission asks IAM again before sending and refuses when that answer is not allow | [#227](https://github.com/SoroushRF/Rehearsal/issues/227) | [T4.19](https://github.com/SoroushRF/Rehearsal/issues/224), [T4.21](https://github.com/SoroushRF/Rehearsal/issues/226) |
| T4.23 | Invites and role changes | M5 | Invite and role routes ask IAM, then Clerk, and assign only roles from the rule file | [#228](https://github.com/SoroushRF/Rehearsal/issues/228) | [T4.20](https://github.com/SoroushRF/Rehearsal/issues/225) |
| T4.24 | Web permissions | M5 | The UI shows permissions from `GET /api/me` and offers only actions the caller holds | [#229](https://github.com/SoroushRF/Rehearsal/issues/229) | [T4.20](https://github.com/SoroushRF/Rehearsal/issues/225), [T4.23](https://github.com/SoroushRF/Rehearsal/issues/228) |
| T4.25 | Clerk configuration | M5 | The four org roles exist, member is the default, and Clerk has no custom `rehearsal:*` permissions | [#230](https://github.com/SoroushRF/Rehearsal/issues/230) | — |
| T4.26 | End-to-end acceptance | M5 | On a real Clerk session each role can do only what the rule file allows | [#231](https://github.com/SoroushRF/Rehearsal/issues/231) | [T4.20](https://github.com/SoroushRF/Rehearsal/issues/225), [T4.21](https://github.com/SoroushRF/Rehearsal/issues/226), [T4.22](https://github.com/SoroushRF/Rehearsal/issues/227), [T4.23](https://github.com/SoroushRF/Rehearsal/issues/228), [T4.24](https://github.com/SoroushRF/Rehearsal/issues/229), [T4.25](https://github.com/SoroushRF/Rehearsal/issues/230) |

### Beyond and benchmark backlog (Oct 24)

See [beyond.md](../beyond.md) for scope, parallel work, external gates and the release cut line. Blockers are completion prerequisites; fixture/contract work may start earlier. Killer rows are optional.

| ID | Task | Milestone | Done when | Issue | Blocked by |
|---|---|---|---|---|---|
| T4.11 | _Beyond:_ Allowlisted rehearsal challenges and controls | M5 | Versioned scoped phantom/conflict/lost-response challenges include benign controls. **Done (fixture):** `packages/core/src/challenges.ts`, `scenarios/billing/challenges.v1.json`, `scripts/inject/challenge.ts`. The runner still only applies `clean` (T3.16). Era: not run | [#169](https://github.com/SoroushRF/Rehearsal/issues/169) | [T1.21](https://github.com/SoroushRF/Rehearsal/issues/163), [T4.2](https://github.com/SoroushRF/Rehearsal/issues/26), [T4.4](https://github.com/SoroushRF/Rehearsal/issues/28) |
| T4.12 | _Beyond:_ Independent verifier for observed rehearsal effects | M5 | Provider reads verify full-operation effects independently of receipt labels. **Done (fixture):** `packages/core/src/verifier.ts` judges reads, not receipt labels. The runner calls it before teardown when a `verify` hook is bound. Era: two tests in `evals/providers/test/rehearsal-run.test.ts`, not run | [#173](https://github.com/SoroushRF/Rehearsal/issues/173) | [T3.15](https://github.com/SoroushRF/Rehearsal/issues/168), [T4.11](https://github.com/SoroushRF/Rehearsal/issues/169) |
| T4.13 | _Beyond:_ Integrated isolation and recovery acceptance gate | M5 | Real end-to-end isolation/recovery gate passes with full precedent integration. Gate spec: [T4.13-isolation-recovery-gate.md](../acceptance/T4.13-isolation-recovery-gate.md) (not run) | [#175](https://github.com/SoroushRF/Rehearsal/issues/175) | [T3.16](https://github.com/SoroushRF/Rehearsal/issues/170), [T2.20](https://github.com/SoroushRF/Rehearsal/issues/172), [T2.21](https://github.com/SoroushRF/Rehearsal/issues/174), [T4.12](https://github.com/SoroushRF/Rehearsal/issues/173), [T1.8](https://github.com/SoroushRF/Rehearsal/issues/9), [T2.17](https://github.com/SoroushRF/Rehearsal/issues/147) |
| T4.14 | _Stretch:_ _Killer:_ Held-out incident datasets and independent gold | M5 | Three disjoint incident sets have independently authored hidden gold. **Owner:** @SoroushRF (benchmark task). **Done (fixture):** `evals/held-out` (sets, gold, integrity/gold/separation tests). Era seeding: `evals/held-out/test/era-seed.test.ts`, not run yet | [#179](https://github.com/SoroushRF/Rehearsal/issues/179) | [T1.2](https://github.com/SoroushRF/Rehearsal/issues/3), [T1.19](https://github.com/SoroushRF/Rehearsal/issues/144) |

## Benchmark fixes (Oct 25)

| ID | Task | Milestone | Done when | Issue | Blocked by |
|---|---|---|---|---|---|
| T4.27 | Note and reply guards check only the ticket fields they use (benchmark owner: @SoroushRF) | M5 | Appends ignore priority-only drift while retaining identity, ownership, status and refund dependency checks; patches retain the full check. Era scripted scorecard: 27/28, zero invalid allows, duplicates or wrongful holds; T3/T10 pass. Self-reviewed; user waived cross-track review in #289 | [#273](https://github.com/SoroushRF/Rehearsal/issues/273) | — |

## Decisions

- **2026-10-24.** Authorization is permissions, decided by a separate IAM service and enforced by the API and the executor ([0014](../decisions/0014-iam-permission-based-authorization.md), proposed).
- **2026-10-21.** A missing, incomplete, or mismatched re-check holds the step as `evidence_unavailable`. It is never treated as proof that the approved rows and query membership are unchanged.

## Handoff log

- **2026-10-25 (skhdemo).** T4.26 on `t4/T4.26-authz-acceptance` at `cc1ce7e`, not pushed. IAM on `https://127.0.0.1:3443` and the API on `http://127.0.0.1:3000` (`GET /api/health` 200) used the existing certs in `infra/iam/dev`. Owner `GET /api/me` stays `live_clerk`: 200, `clerkRole` `org:owner`, with both approve permissions plus invite and manage role, from the Frontend API sign-in whose `azp` was `http://localhost:5173`. The same sign-in, one attempt each, then `GET /api/me`: finance 200 `org:finance_lead` with both approve permissions, apply, cancel, revoke own, revoke any, promote, and withdraw, and without invite or manage role (`live_clerk`); support 200 `org:support_lead` with approve support, apply, cancel, and revoke own, and without approve finance, revoke any, invite, manage role, promote, or withdraw (`live_clerk`); member 200 `org:member` with only `rehearsal:read:plan`, `rehearsal:read:run`, and `rehearsal:read:precedent` (`live_clerk`). Member `POST /api/members/invitations` (`t426-denied@example.com`, `org:member`) returned 403 `{"error":"forbidden"}` and Clerk invitations stayed 0. With the API still up, one member Frontend API sign-in (`azp` `http://localhost:5173`) was followed by stopping only the IAM process on 3443; `GET /api/me` once returned 503 `{"error":"iam_unavailable"}`. IAM was started again and a fresh member sign-in `GET /api/me` returned 200 `clerkRole` `org:member`. No demo org was deleted and the executor was not started. One Clerk organization `T4.26 other` (`org_3LCCFoNv4v2XpMVNckBMyRzZ6u4`) was created by `rehearsal-member`. A Frontend API sign-in, then one `POST /v1/client/sessions/{id}/touch` with that org, gave `GET /api/me` 200 `orgId` `org_3LCCFoNv4v2XpMVNckBMyRzZ6u4`. `GET /api/plans/plan_happy` with that token returned 404 `{"error":"plan_not_found"}`. `plan_t426_dual` cites billing-remedy version 3. Owner approval left `approval.satisfied` false with one signed actor `user_3LC5M2kWRSLRd1jVu1HaWrNEqDg` and needed `rehearsal:approve:support_step`. Support approval then left `satisfied` true with signed actors `user_3LC5M4A6ckmqtNzPUzhsxysdpFJ` and `user_3LC5M2kWRSLRd1jVu1HaWrNEqDg`. Owner revoke of the support grant returned 200, and owner `POST /api/plans/plan_t426_dual/apply` returned 403 `{"error":"forbidden"}`. The executor was not started. Before a second rule file, IAM `run:admit` for `rehearsal-authz` version 2 denied with reason `unknown rule rehearsal-authz@2`. After `rehearsal-authz.v2.json` (version 2 only) and an IAM restart that loaded 2 rule files, the same decide denied with `rule.version` 2 and reason `rule 24: resource.dualRequired != true`. `plan_t426_dual` grants stayed `{"id":"rehearsal-authz","version":1}`. The v2 file was removed and is not in that commit. The owner grant stayed live. Support posted a new approval, and `approval.satisfied` was true with signed actors `user_3LC5M4A6ckmqtNzPUzhsxysdpFJ` and `user_3LC5M2kWRSLRd1jVu1HaWrNEqDg`. That grant was not revoked. Owner `POST /api/plans/plan_t426_dual/apply` returned 202 `runId` `run_3b66343e-d69e-47d5-af8c-df5d08e96105`. The executor was not started. A member Frontend API sign-in, then one touch of `org_3LCCFoNv4v2XpMVNckBMyRzZ6u4`, gave `GET /api/me` 200 `orgId` `org_3LCCFoNv4v2XpMVNckBMyRzZ6u4`. `GET /api/plans/plan_t426_dual/runs` with that token returned 404 `{"error":"plan_not_found"}`. IAM was stopped and left down. Stripe and Zendesk operational simulators answered HTTP on `127.0.0.1:8102` and `127.0.0.1:8112`. The executor was started once and logged `executor-worker consuming apply (stripe=http://127.0.0.1:8102, zendesk=http://127.0.0.1:8112, slack=off)`. Within 45 seconds no log line contained `IAM is unavailable`. Other jobs were skipped or logged as `run failed (grant expired)` or `run cancelled (run was cancelled)`; `run_3b66343e-d69e-47d5-af8c-df5d08e96105` was not named. The executor was then stopped. That run's state stayed `approved`, and `run_events` had no rows, including no `run.admitted` or `step.receipt`.
- **2026-10-25 (skhdemo).** T4.25 on `t4/T4.25-clerk-config`, not pushed. Role keys are `org:owner`, `org:finance_lead`, `org:support_lead`, and `org:member`. `org:owner` is the creator and the only role with member-management permissions. `org:member` is the default. `org:admin` is gone. No `rehearsal:*` permission exists. Demo org `org_3LC5MEwJx0gCIdJysEanpUpv6Lg` is named Rehearsal Demo. Users `rehearsal-owner`, `rehearsal-finance`, `rehearsal-support`, and `rehearsal-member` hold those roles. Happy-path plan `plan_happy` revision 1 is stored under that org.
- **2026-10-25 (skhdemo).** T4.12 is on `t4/T4.12-verifier`. The verifier (`verifier@1`) compares provider reads to the scenario bound in T4.11. A confirmed receipt with a green effect does not match, and a failed or unfinished list is unverified, so the verdict stays unknown. The runner reads only when its context has `verify`, and it does that before teardown. The sweeper still reports unverified: it may no longer have the tenant. Challenged scenarios are still not applied (T3.16). Evidence is `fixture`. Era: not run.
- **2026-10-25 (skhdemo).** T4.24 is on main. The review UI reads `GET /api/me` (`clerkRole` and `permissions`) and offers approve, apply, cancel, revoke, rehearse, and invite only when the caller holds that permission. An owner can invite or change a role. Approval seats display the permission the API returns.
- **2026-10-25 (skhdemo).** T4.11 is on `t4/T4.11-challenge-catalog`. The catalog is version 1 of `clean`, `phantom_membership`, `teammate_field_edit`, `lost_response_restart` and `benign_nonmatching_change`. Challenges name a case in the plan; charge ids are derived when the plan is bound. The teammate edit is the first patch case (the demo script's c02 is a different mapping). It has to run after that note is rejected and before compensation re-reads the ticket; later, the undo already restored the plan's value. `scripts/inject/challenge.ts` injects only into `rh-<id>` on a rehearsal URL, and only `/inject`. A lost response is a runner transport mode, not an Era fault. Nothing in v1 sets a container-wide fault. The API and the runner still refuse every scenario but `clean`; applying the rest is T3.16. Evidence is `fixture`. No precedent challenge: that waits on the registry. `equals: "teammate"` in the JSON is a role; the bound effect's value is `urgent`.
- **2026-10-25 (skhdemo).** T4.22 is implemented on `t4/T4.22-executor-admit` and not pushed. Before an operational run sends, admission asks IAM `run:admit` on the stored grants. A missing seat, a revoked or expired grant, one person in both seats, or IAM down refuses the run and dispatches nothing.
- **2026-10-25 (skhdemo).** T4.23 is implemented on `t4/T4.23-member-routes` and not pushed. Invite and role routes ask IAM, then IAM calls Clerk for the organization it verified from the token. Only a role in the rule file can be assigned, and the last owner cannot be demoted.
- **2026-10-25 (skhdemo).** T4.21 is implemented on `t4/T4.21-grant-permissions` and not pushed. New grants store the approver's permissions and the rule id and version; dual-approval seats are those permissions. A role-only grant fills no seat.
- **2026-10-25 (skhdemo).** T4.20 on `t4/T4.20-api-enforcement` ([#288](https://github.com/SoroushRF/Rehearsal/pull/288)). Person routes ask IAM over mTLS and send the session token; the API no longer holds the Clerk secret or checks `CLERK_ROLES`. `GET /api/me` uses IAM's identity call. Apply also asks `run:admit` on stored grants, so a role-only grant is not queued. Grant schema and the executor are unchanged (T4.21, T4.22).
- **2026-10-25 (Claude for @SoroushRF, T4.13).** Wrote the gate spec in [docs/acceptance](../acceptance/T4.13-isolation-recovery-gate.md): checks G1–G4, the existing component tests behind each, and the record it must leave. Nothing ran: T2.19, T3.16, T4.11, T4.12, T2.20, T2.21 and T2.17 are open, so there's no API path to drive. Next: once T2.19 lands, write the operator script and Playwright spec it describes.
- **2026-10-25 (skhdemo).** T4.19 in progress on `t4/T4.19-iam-service`: IAM listens over mTLS, loads `scenarios/authz/`, and the API and executor refuse to boot without a client certificate. The planner is refused if it has one. Not pushed.
- **2026-10-25 (skhdemo).** Precedent permissions added to contracts and decision 0014; rule file (T4.17) and engine (T4.18) pick them up.
- **2026-10-25 (Claude for @SoroushRF, T4.14).** Added `evals/held-out`: three held-out incidents (INC-BILL-0612/0715/0818, policies v2/v3/v1) with 18 tasks and hand-authored gold, pinned to its inputs. `incidentRecords` in testkit gained `triple` and `control_failed_retry` kinds, per-set ID prefixes, a USD balance and a mislinked ticket; INC-BILL-0927 output is byte-identical. Offline tests pass. The Era seed check (`ERA_CONFORMANCE=1`) is written but not run (Docker was down), so the manifest says `eraSeed: "not_run"`. Next: run it, flip the label, then T1.25/T1.26 add their scorer to `GOLD_READERS`.
- **2026-10-24 (skhdemo).** Decision 0014 is proposed on `t4/T4.15-iam-decision`; no code yet. Next is T4.16.
- **2026-10-24 (Codex, backlog planning):** Filed 4 owned M5 issues (T4.11 #169, T4.12 #173, T4.13 #175, T4.14 #179) with scope/track labels, acceptance criteria and linked blockers. Added the cross-track dependency map in [beyond.md](../beyond.md); native GitHub dependencies mirror these rows. No feature implementation or live validation is claimed. Next: finish the full prerequisites, then follow the graph; optional killer work stays off the main release path.

_(newest first: date, who, state, open PRs or branches, next step, gotchas)_

### 2026-10-24, T4.10 review fixes (PR #199 by @skhdemo, merged with fixes)

- **Replay after an unknown send is re-checked.** The in-run idempotent replay used to skip the step guard. It now reads whether the earlier send landed; if it can't show that, the guard runs, and a hold settles the step `unknown_outcome` without re-sending.
- **Across plans and revisions.** `ApplyStore.remedyStepsFor` lists every refund or credit step for the obligation in the org's stored plans. The executor passes their attempts to the guard as `priorRemedies`; a dispatched, unknown, confirmed or reconciled one holds. A store without the method holds every remedy.
- **Credits.** `remedyOf` switches over every action kind, so T1.14's credit has to be added there. A confirmed credit settles its obligation. An untagged credit in the same currency that is no larger than the step holds it (a partial credit). Credit notes are listed too.
- **Refund check.** A charge's refunded amount only holds when it is more than the approved evidence plus this plan's own refunds of that charge.
- **Not closed: two plans racing.** Both can read "no remedy" before either sends. See decision 0010.
- **Next.** @ArtinMe tags our own credits with `metadata[charge]` in T3. T1.14 adds the credit case to `remedyOf` and the executor.

### 2026-10-24, T4.10 one remedy per obligation

- **A refund is held when that obligation already has a remedy.** The step guard lists the customer's balance credits after the usual re-read. A credit that names the charge, or an untagged credit of the same amount and currency, holds the refund as `R5.remedy_already_completed`. A credit for another charge does not. A second refund of an obligation this plan already confirmed is held the same way. A credit step is held when its charge already has a refund (`readRemedyHold`); the credit op is still not in `Action`, so that direction is not sent by `executeRun`.
- **Evidence.** Fixture: `apps/executor-worker/test/one-remedy.test.ts`. Era: `evals/providers/test/one-remedy.test.ts`, gated on `ERA_CONFORMANCE=1`. The Era run was not executed in this session.
- **Next.** T4.11 once T1.21's rehearsal contracts exist. Scenario files can be drafted before that.

### 2026-10-24, ML deferred

- **T4.5–T4.7 are out of the hackathon** ([0008](../decisions/0008-ml-out-of-hackathon-scope.md)). The issues are closed as not planned. They block nothing. `ImpactPort` stays `alwaysAbstain`.
- **PR #102 is closed unmerged.** No weights or smoke logs land on `main`.
- **Next.** T4.10 has since landed. The beyond rehearsal tasks are next, starting with T4.11 once T1.21's rehearsal contracts exist.

### 2026-10-23, compensation follow-ups #103 and #109

- **A late undo no longer hides a leftover conflict (#103).** If an earlier undo restored only some fields, and a follow-up 409 leaves another field with a teammate's value, the receipt is `compensation_conflict`. It is `compensated` only when nothing genuine remains. Fixture evidence: `apps/executor-worker/test/compensation.test.ts`.
- **Stacked patches on one field are undone latest first (#109).** A chain normal → high → urgent returns to normal. An older patch waits, with no receipt, while the later undo is unresolved or has given up (a 500 that never landed, a lost response, or repeated 409s). A field the later undo restored is still unwound when another field on that patch conflicts, including when that undo's response was lost and a later run (or a new revision) reads it back. The proof is the journaled undo request, not only the receipt text. A later patch that was held before it ever dispatched does not block the older undo. A later send that is still unknown under an earlier revision does, including when a new revision is the one looking it up. A teammate edit is kept, including one equal to an earlier patch's own write. The current planner still emits one patch per ticket.
- **Next.** Superseded 2026-10-24: T4.5–T4.7 are deferred ([0008](../decisions/0008-ml-out-of-hackathon-scope.md)).

### 2026-10-22, T4.4 done on Era

- **`teammate-conflict` passes on Era** (`evals/providers/test/compensation.test.ts`, `ERA_CONFORMANCE=1`). Evidence: `era_integration`.
  - It seeds the T1.2 cohort into both worlds and builds the plan from planning-world reads. c02's note is refused in the harness (Era's faults only give 429s and 5xx).
  - Untouched, compensation restores c02's priority with a stamp-guarded patch and keeps the refund. c01 is left as applied.
  - A teammate edit through the ordinary ticket API, after the failed note, is kept: `compensation_conflict`, nothing written after the edit.
- **A lost undo is reconciled by a read.** The undo carries a private marker. A later run records it only when that marker is on the ticket, so someone else restoring the same value is not `compensated`. A read that shows the undo never landed allows one fresh undo once the attempt is old enough. The old attempt stays open until that fresh undo is dispatched, so a dependent of the patch stays recovery-only (#99) and a revision that no longer compensates does not adopt the patch. That read is fixture evidence (`apps/executor-worker/test/compensation.test.ts`); the Era gate does not drop an undo response.
- **Next.** T4.5, the ML smoke test, on the GPU machine. Follow-ups from the part-1 review (a 429 on the undo, the label when a teammate sets a field back to our before value, two patches of one field, duplicate held receipts, Postgres) are not in this task.

### 2026-10-22, T4.4 part 1

- **Compensation is in, behind a `compensate` hook in the executor** (like `guard`). `createCompensator` in `packages/core/src/compensation.ts` implements it, and the executor worker installs it. The rules are in [decision 0007](../decisions/0007-when-compensation-runs.md).
- **The `teammate-conflict` bundle passes on the fake world** (`apps/executor-worker/test/compensation.test.ts`).
- **The bundle's teammate edit now lands after the failed note**, not after the patch. An edit before the note makes the read guard hold the note, so the case never fails and nothing is compensated.
- **Next.** Part 2: the same bundle on Era (`evals/providers/test/compensation.test.ts`, written and passing locally), then mark T4.4 done.

### 2026-10-22, T4.2 follow-up

- **The demo scripts act on the T1.2 cohort.** `DEMO` in `scripts/inject/session.ts` replaces `SEED`:
  - `demo:phantom` injects `ch_INC0927c01phantom` for c01 (a copy of its CAD duplicate, created 2026-09-25), plus an October control that must stay outside the window.
  - `demo:conflict` edits c02's ticket (`9100002`), the case the `teammate-conflict` bundle uses.
  - `demo:fault` reads c01's first charge.
- **Run `pnpm demo:reset` first.** It seeds the cohort the scripts expect. All four scripts pass on local Era.
- **Next.** T4.4.

### 2026-10-22, T4.3 done on Era

- **`phantom` passes on Era** (`evals/providers/test/phantom.test.ts`, `ERA_CONFORMANCE=1`). Evidence: `era_integration`.
  - It seeds the T1.2 cohort into both worlds and builds the plan from planning-world reads of c01 and c02. Those cases match the fixture plan's amounts and roles.
  - It then injects an in-window duplicate (`ch_INC0927c01phantom`) for c01 into the operational world only.
  - `executeRun` with the real read and write adapters and `createReadGuard` holds `refund_001` (`query_membership_changed`, added the phantom) and skips `note_001`. c02's refund, patch and note apply.
  - The world agrees: there's no refund on any c01 charge and one on c02's duplicate, and the planning world never sees the phantom.
  - With the guard removed, the same test refunds c01, so it really exercises the guard.
- **Next.** T4.2 follow-up: point `SEED` in `scripts/inject/session.ts` at a cohort case, so `demo:phantom` and `demo:conflict` act on the incident. Then T4.4. T3 still has to pass `guard: createReadGuard(...)` when it wires the executor worker.

### 2026-10-22, T4.3 part 2

- **Review follow-ups from #47 are in.**
  - The own-write overlay is keyed by record (`entityKey`), not by observation id.
  - A full refund also expects `refunded: true`.
  - Patch and note receipts credit the ticket's `updated_at` from the write response.
  - The read guard re-reads each record and query once per step.
  - The fake world's query now honours the window and the cutoff when a charge has `created`.
- **Not changed, on purpose:**
  - An adopted refund can't be counted twice today, because a revision keeps its parent's observations (`excludeActions`) and the executor never writes the planning world. A test pins that.
  - Query membership has no own-write overlay. `byCustomerInWindow` can't be moved by our writes; add one before adding a predicate that can.
- **Don't add `updated_at` to a ticket projection without revisiting `creditUpdatedAt`.** Once it's compared, crediting our response's stamp can hide a teammate's edit to a field we don't project (tags, assignee, a public reply). That happens when they write between the guard's re-read and our note (notes carry no `safe_update`), or in the same second as our write (one-second precision, capability matrix §9). Today it's a no-op: `zendeskTicketProjection` is `id`, `priority`, `status` and `requester_id`.
- **Gotcha.** A patch adopted from an earlier revision has no `updated_at` in its receipt. Once T1's ticket projection includes `updated_at`, a later note on that ticket will hold after a re-approval. This fails closed.
- **Still open (#27).** The Era run waits on T1.3 #4 and T3's worker wiring.

### 2026-10-21, T4.3 part 1

- **The guards run inside the executor on the fake provider.** `createReadGuard` in `packages/core/src/step-guard.ts` is the executor's `StepGuard`. Before a step is sent, it re-reads that step's evidence through the operational `ProviderPort`s and calls `guardAction`. The own-write overlay is built from `confirmedReceipts`. The `phantom` bundle passes through `executeRun` (`apps/executor-worker/test/step-guard.test.ts`).
- **Still open (#27).** The task is done when `phantom` passes on Era, which needs T1.3's read adapters, T3.3's write adapters, and T1.9's tenant tokens. Those were added to **Blocked by**.
- **Next.** When T3 wires the executor worker to consume `apply` jobs, pass `guard: createReadGuard({ providers, worlds, clock })` with the same operational providers and worlds as the executor. Then run the phantom scenario on Era with `pnpm demo:phantom`.
- **Gotcha.** A ticket step holds on any change to a planned ticket field, including a note whose own write doesn't touch that field. That is deliberate (a hold, never a false admit). Relax it only with a decision.

### 2026-10-21, T4.2

- **T4.2 runs on local Era.** `pnpm demo:reset`, `demo:phantom`, `demo:conflict` (with an optional `--priority=`), and `demo:fault` are in `scripts/inject/`. Each prints one line per check and exits non-zero on a failure.
- **Gotcha (superseded 2026-10-22, see above).** They targeted the image's seeded customer `cus_necGym2uIJ94j40b` and ticket `4000001` until the T1.2 cohort landed.
- **Gotcha.** Faults are container-wide. `demo:fault` clears them before exiting. Never run `demo:reset` while an executor is applying: reset forgets Stripe idempotency keys.

### 2026-10-21, T4.1

- **T4.1 is done on fixtures.** `guardAction`, `compareObservation`, `diffQueryMembership`, and `advanceOverlay` are in `packages/core/src/guards.ts`. Tests cover the phantom bundle, a missing or incomplete re-check, and an own write that must not false-hold the note after it.
- **Next.** T4.2 injection scripts against the local Era worlds. Wiring the guards into admission (T4.3) waits on the executor loop (#19).
- **Gotcha.** The ML notes assume an RTX 4070 with 8 GB. The current machine has an RTX 5080 with 16 GB and a CUDA 13.3 driver, so pick training wheels to match it.
