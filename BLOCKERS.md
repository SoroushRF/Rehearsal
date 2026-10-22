# Blocker board

**Generated automatically. Don't edit this file.** It rebuilds when issues change or anything merges to main, and every 10 minutes. Dependencies come from the **Blocked by** column in [`docs/tracks/`](https://github.com/SoroushRF/Rehearsal/tree/main/docs/tracks); change them there through a PR.

Legend: ✅ done · 👀 in review · 🔨 in progress · 🟨 ready · 🟥 blocked

## Top blockers

13 of 32 tasks done. These open tasks hold up the most other work:

| Task | Track owner | Status | Open tasks waiting on it |
|---|---|---|---|
| **T2.9** Decide currency: align policy.v1.json with the Era seed (USD vs CAD) [#40](https://github.com/SoroushRF/Rehearsal/issues/40) | _TBD_ | 🟨 ready | 5 |
| **T1.5** Bounded Claude tool loop and planner-worker plan jobs [#6](https://github.com/SoroushRF/Rehearsal/issues/6) | _TBD_ | 🟥 blocked | 4 |
| **T2.2** API: store plans, get plan, create revisions with expected-hash check [#11](https://github.com/SoroushRF/Rehearsal/issues/11) | _TBD_ | 🟨 ready | 3 |
| **T2.3** Clerk sign-in, support_lead / finance_lead roles, and server-side checks [#12](https://github.com/SoroushRF/Rehearsal/issues/12) | _TBD_ | 🟨 ready | 2 |
| **T4.5** ML smoke test: Qwen3.5-0.8B LoRA on 32 cases [#29](https://github.com/SoroushRF/Rehearsal/issues/29) | _TBD_ | 🟨 ready | 2 |
| **T2.4** Approvals endpoint: hash-bound grant and refusal test matrix [#13](https://github.com/SoroushRF/Rehearsal/issues/13) | _TBD_ | 🟥 blocked | 1 |

## T1 Rehearse

**Owner:** _TBD_

| Task | Status | Blocked by | Blocks |
|---|---|---|---|
| **T1.1** Era day-one gate: conformance tests and capability matrix [#2](https://github.com/SoroushRF/Rehearsal/issues/2) | ✅ done |  | T1.2, T1.3, T1.9 |
| **T1.2** Seed the incident cohort into both worlds, plus demo:reset [#3](https://github.com/SoroushRF/Rehearsal/issues/3) | ✅ done |  | T1.5 |
| **T1.3** Read adapters: charges, tickets and query predicates [#4](https://github.com/SoroushRF/Rehearsal/issues/4) | ✅ done |  | T1.4, T4.3 (T4) |
| **T1.4** Typed planning tools that record evidence and dependency edges [#5](https://github.com/SoroushRF/Rehearsal/issues/5) | ✅ done |  | T1.5 |
| **T1.5** Bounded Claude tool loop and planner-worker plan jobs [#6](https://github.com/SoroushRF/Rehearsal/issues/6) | 🟥 blocked | T2.9 (T2, ready) | T1.6, T1.7, T1.8, T2.5 (T2) |
| **T1.6** ~20 benign and trap tasks plus baselines for the scorecard [#7](https://github.com/SoroushRF/Rehearsal/issues/7) | 🟥 blocked | T1.5 (T1, blocked) |  |
| **T1.7** Slack summary step (slack.message.postSummary) _(stretch)_ [#8](https://github.com/SoroushRF/Rehearsal/issues/8) | 🟥 blocked | T1.5 (T1, blocked) |  |
| **T1.8** SurrealDB precedents (explicit promotion, recall with trace) _(stretch)_ [#9](https://github.com/SoroushRF/Rehearsal/issues/9) | 🟥 blocked | T1.5 (T1, blocked) |  |
| **T1.9** Signed Era tenant tokens in both workers [#39](https://github.com/SoroushRF/Rehearsal/issues/39) | ✅ done |  | T1.2, T1.5, T3.3 (T3), T4.3 (T4) |

## T2 Review & Approve

**Owner:** _TBD_

| Task | Status | Blocked by | Blocks |
|---|---|---|---|
| **T2.1** Plan diff view from fixture bundles [#10](https://github.com/SoroushRF/Rehearsal/issues/10) | 🟨 ready | — |  |
| **T2.2** API: store plans, get plan, create revisions with expected-hash check [#11](https://github.com/SoroushRF/Rehearsal/issues/11) | 🟨 ready | — | T2.4, T2.5 |
| **T2.3** Clerk sign-in, support_lead / finance_lead roles, and server-side checks [#12](https://github.com/SoroushRF/Rehearsal/issues/12) | 🟨 ready | — | T2.4 |
| **T2.4** Approvals endpoint: hash-bound grant and refusal test matrix [#13](https://github.com/SoroushRF/Rehearsal/issues/13) | 🟥 blocked | T2.2 (T2, ready)<br>T2.3 (T2, ready) | T2.8 |
| **T2.5** Deploy thin slice and prove cloud workers reach the simulators [#14](https://github.com/SoroushRF/Rehearsal/issues/14) | 🟥 blocked | T2.2 (T2, ready)<br>T1.5 (T1, blocked) |  |
| **T2.6** Run timeline, receipts and held-step views (polling GET /api/runs/:id/events) [#15](https://github.com/SoroushRF/Rehearsal/issues/15) | 🟨 ready | — | T2.7 |
| **T2.7** Two-minute video script, recording, Devpost page [#16](https://github.com/SoroushRF/Rehearsal/issues/16) | 🟥 blocked | T2.6 (T2, ready) |  |
| **T2.8** Thin Expo approver app on the same API _(stretch)_ [#17](https://github.com/SoroushRF/Rehearsal/issues/17) | 🟥 blocked | T2.4 (T2, blocked) |  |
| **T2.9** Decide currency: align policy.v1.json with the Era seed (USD vs CAD) [#40](https://github.com/SoroushRF/Rehearsal/issues/40) | 🟨 ready | — | T1.5 (T1) |

## T3 Apply

**Owner:** _TBD_

| Task | Status | Blocked by | Blocks |
|---|---|---|---|
| **T3.1** Drizzle migrations, Postgres journal, pg-boss, apply endpoint [#18](https://github.com/SoroushRF/Rehearsal/issues/18) | ✅ done |  | T2.2 (T2), T3.2 |
| **T3.2** Executor loop on a FakeProvider [#19](https://github.com/SoroushRF/Rehearsal/issues/19) | ✅ done |  | T2.5 (T2), T2.6 (T2), T3.3, T4.3 (T4) |
| **T3.3** Write adapters: Stripe refund, Zendesk patch, private note [#20](https://github.com/SoroushRF/Rehearsal/issues/20) | ✅ done |  | T3.4, T3.6, T4.3 (T4), T4.4 (T4) |
| **T3.4** Retries with bounded backoff and Retry-After [#21](https://github.com/SoroushRF/Rehearsal/issues/21) | ✅ done |  | T3.5 |
| **T3.5** Unknown outcome: lost response, restart, reconcile through reads [#22](https://github.com/SoroushRF/Rehearsal/issues/22) | ✅ done |  | T3.7 |
| **T3.6** ID divergence test, partial-completion state, cancellation [#23](https://github.com/SoroushRF/Rehearsal/issues/23) | 🟨 ready | — | T3.7 |
| **T3.7** Bounded concurrency across independent cases [#24](https://github.com/SoroushRF/Rehearsal/issues/24) | 🟥 blocked | T3.6 (T3, ready) |  |

## T4 Guard

**Owner:** _TBD_

| Task | Status | Blocked by | Blocks |
|---|---|---|---|
| **T4.1** Pure guards: observation compare, query-membership diff, own-write overlay [#25](https://github.com/SoroushRF/Rehearsal/issues/25) | ✅ done |  | T4.3 |
| **T4.2** Injection scripts and demo:phantom / demo:conflict / demo:reset [#26](https://github.com/SoroushRF/Rehearsal/issues/26) | ✅ done |  | T1.6 (T1), T4.3 |
| **T4.3** Wire guards into executor admission [#27](https://github.com/SoroushRF/Rehearsal/issues/27) | ✅ done |  | T4.4 |
| **T4.4** Conditional compensation on owned fields [#28](https://github.com/SoroushRF/Rehearsal/issues/28) | 🟨 ready | — |  |
| **T4.5** ML smoke test: Qwen3.5-0.8B LoRA on 32 cases [#29](https://github.com/SoroushRF/Rehearsal/issues/29) | 🟨 ready | — | T4.6 |
| **T4.6** ML pilot and go/no-go [#30](https://github.com/SoroushRF/Rehearsal/issues/30) | 🟥 blocked | T4.5 (T4, ready) | T4.7 |
| **T4.7** Impact service behind ImpactPort (if ML go) [#31](https://github.com/SoroushRF/Rehearsal/issues/31) | 🟥 blocked | T4.6 (T4, blocked) |  |

## Task graph

An arrow `A --> B` means B waits on A. Stretch tasks are left out.

```mermaid
flowchart LR
  classDef done fill:#d3f9d8,stroke:#2b8a3e,color:#1b4332
  classDef review fill:#d0ebff,stroke:#1971c2,color:#0b3460
  classDef progress fill:#e5dbff,stroke:#5f3dc4,color:#2b1a66
  classDef ready fill:#fff3bf,stroke:#e67700,color:#5c3c00
  classDef blocked fill:#ffe3e3,stroke:#c92a2a,color:#5c0a0a
  subgraph T1[T1 Rehearse]
    T1_1["T1.1 Era day-one gate: conformance tests and cap"]:::done
    T1_2["T1.2 Seed the incident cohort into both worlds, "]:::done
    T1_3["T1.3 Read adapters: charges, tickets and query p"]:::done
    T1_4["T1.4 Typed planning tools that record evidence a"]:::done
    T1_5["T1.5 Bounded Claude tool loop and planner-worker"]:::blocked
    T1_6["T1.6 ~20 benign and trap tasks plus baselines fo"]:::blocked
    T1_9["T1.9 Signed Era tenant tokens in both workers"]:::done
  end
  subgraph T2[T2 Review & Approve]
    T2_1["T2.1 Plan diff view from fixture bundles"]:::ready
    T2_2["T2.2 API: store plans, get plan, create revision"]:::ready
    T2_3["T2.3 Clerk sign-in, support_lead / finance_lead "]:::ready
    T2_4["T2.4 Approvals endpoint: hash-bound grant and re"]:::blocked
    T2_5["T2.5 Deploy thin slice and prove cloud workers r"]:::blocked
    T2_6["T2.6 Run timeline, receipts and held-step views "]:::ready
    T2_7["T2.7 Two-minute video script, recording, Devpost"]:::blocked
    T2_9["T2.9 Decide currency: align policy.v1.json with "]:::ready
  end
  subgraph T3[T3 Apply]
    T3_1["T3.1 Drizzle migrations, Postgres journal, pg-bo"]:::done
    T3_2["T3.2 Executor loop on a FakeProvider"]:::done
    T3_3["T3.3 Write adapters: Stripe refund, Zendesk patc"]:::done
    T3_4["T3.4 Retries with bounded backoff and Retry-Afte"]:::done
    T3_5["T3.5 Unknown outcome: lost response, restart, re"]:::done
    T3_6["T3.6 ID divergence test, partial-completion stat"]:::ready
    T3_7["T3.7 Bounded concurrency across independent case"]:::blocked
  end
  subgraph T4[T4 Guard]
    T4_1["T4.1 Pure guards: observation compare, query-mem"]:::done
    T4_2["T4.2 Injection scripts and demo:phantom / demo:c"]:::done
    T4_3["T4.3 Wire guards into executor admission"]:::done
    T4_4["T4.4 Conditional compensation on owned fields"]:::ready
    T4_5["T4.5 ML smoke test: Qwen3.5-0.8B LoRA on 32 case"]:::ready
    T4_6["T4.6 ML pilot and go/no-go"]:::blocked
    T4_7["T4.7 Impact service behind ImpactPort (if ML go)"]:::blocked
  end
  T1_1 --> T1_2
  T1_9 --> T1_2
  T1_1 --> T1_3
  T1_3 --> T1_4
  T1_2 --> T1_5
  T1_4 --> T1_5
  T1_9 --> T1_5
  T2_9 --> T1_5
  T1_5 --> T1_6
  T4_2 --> T1_6
  T1_1 --> T1_9
  T3_1 --> T2_2
  T2_2 --> T2_4
  T2_3 --> T2_4
  T2_2 --> T2_5
  T1_5 --> T2_5
  T3_2 --> T2_5
  T3_2 --> T2_6
  T2_6 --> T2_7
  T3_1 --> T3_2
  T3_2 --> T3_3
  T1_9 --> T3_3
  T3_3 --> T3_4
  T3_4 --> T3_5
  T3_3 --> T3_6
  T3_5 --> T3_7
  T3_6 --> T3_7
  T4_1 --> T4_3
  T4_2 --> T4_3
  T3_2 --> T4_3
  T1_3 --> T4_3
  T3_3 --> T4_3
  T1_9 --> T4_3
  T4_3 --> T4_4
  T3_3 --> T4_4
  T4_5 --> T4_6
  T4_6 --> T4_7
```
