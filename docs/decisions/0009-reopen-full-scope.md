# 0009: Reopen the full scope (T1.16)

**Status:** accepted 2026-10-24 (Soroush, T1). Please raise objections in team chat or on the PR.

## Context

On Oct 21 we cut to the trimmed scope ([plan.md](../plan.md#trim-decision-oct-21-evening)): no Slack, SurrealDB, Expo or model serving, and a feature freeze after M4. The trimmed core now works end to end against Era. A real model planned the seeded cohort, a reviewer approved the hash in the UI, and the executor applied it 24/24 (#131). The hero moments pass, and every T3 task plus T4.1–T4.4 is done. The remaining features are the "Full" column of [build-plan.md](../source/build-plan.md). That column needs new typed ops, a new database and work in every track, so the board couldn't show it until the scope was reopened.

## Decision

1. **The trim is reversed.** These are back in scope, each with a task on the [blocker board](https://github.com/SoroushRF/Rehearsal/blob/status/BLOCKERS.md):
   - Slack summary (T1.7)
   - SurrealDB precedents (T1.8)
   - Public customer reply (T1.13)
   - Invoice-balance credit (T1.14)
   - Real-model scorecard (T1.15)
   - Two distinct approvers (T2.13)
   - Historical audit view (T2.14)
   - Expo approver (T2.8)
   - Post-write read-back (T3.8)
2. **ML stays out.** Training, the impact service and shadow sampling are not part of the hackathon in either scope ([0008](0008-ml-out-of-hackathon-scope.md), T4). `ImpactPort` stays `alwaysAbstain`.
3. **The freeze is lifted.** Track branches (`t1/…` to `t4/…`) and `contracts/…` branches land on `main` again through PRs with green CI. Deploy (T2.5) and the video (T2.7) wait until the full version is in.
4. **Slack is in.** This settles [0001](0001-open-team-decisions.md) #2: one `slack.message.postSummary` post as the final step of a run. Slack doesn't deduplicate on `client_msg_id`, so an uncertain post is resolved by reading the channel and is never re-sent blindly.
5. **SurrealDB is allowed, as the precedent store only.** This is the decision record AGENTS.md requires before adding a database. It holds human-promoted precedents, recalled with a trace, behind `PrecedentPort`. It holds no operational state: plans, approvals, attempts and receipts stay in Postgres. If we can't get access to the SurrealDB Agent Memory pack, T1.8 and T2.17 are dropped. Nothing else depends on them.
6. **New effects arrive only as typed contracts ops.** The three new ops are `slack.message.postSummary` (T1.17), `zendesk.ticket.appendPublicReply` (T1.18) and `stripe.customer.balanceCredit` (T1.19). Each is additive, small, reviewed by another track, merged before the code that uses it, and added to the AGENTS.md list. No arbitrary URL, method or patch tools.
7. **The rules don't change.** The rules in AGENTS.md hold for every new feature:
   - separate credentials
   - no model in execution
   - approval for an exact hash
   - journal before dispatch
   - integer money
   - append-only history
   - labelled evidence

## Consequences

- The work runs in waves; the board's **Blocked by** column has the details.
  1. This record.
  2. The three contracts ops, then T1.8.
  3. The T2 views, T3 write adapters and T4.10 guard that use them.
  4. T1.7, T1.13 and T1.14.
  5. Deploy and video.
- T2 carries the most new work (T2.13–T2.18 plus T2.8). Moving some of it to another owner shortens the timeline; that is a roster change under AGENTS.md.
- Each new op changes the plan hash input for plans that use it. Plans and approvals made before an op existed stay valid, because their hash never contained it.
- If the full version isn't done by the submission deadline (Oct 25), we submit what is on `main`, with each feature labelled by evidence level.
