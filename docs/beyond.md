# Beyond-full delivery and dependency map

Agreed backlog, 2026-10-24: **15 beyond + 8 killer + 2 benchmark tasks**. All target M5 Ship; labels distinguish scope, not completed functionality. ML training/serving is excluded by decision 0008 and is not a prerequisite anywhere in this extension.

## Ownership and scope

| Track | Owner | Beyond | Killer | Additional benchmark | Total |
|---|---|---:|---:|---:|---:|
| T1 Rehearse | @SoroushRF | 4 | 3 | 2 | 9 |
| T2 Review & Approve | @parsaabbasian | 4 | 2 | 0 | 6 |
| T3 Apply | @ArtinMe | 4 | 2 | 0 | 6 |
| T4 Guard | @skhdemo | 3 | 1 | 0 | 4 |
| Total | | 15 | 8 | 2 | 25 |

The main extension executes an exact stored plan in disposable Era worlds, applies allowlisted challenges, independently reads the effects and shows a report before operational approval. The existing incident-to-plan "rehearse" flow remains a different operation. No report grants operational authority or guarantees that later live state will match.

`killer` tasks are optional prize-focused slices and also carry `stretch`. T1.25, T1.26 and T4.14 additionally carry `benchmark`; they are part of the eight killer tasks, not additional issues. Operator testing is beyond T2.22; there is no outside validation yet.

## Sequence and cross-track handoffs

| Wave | Work that can proceed together | Acceptance prerequisite / next handoff |
|---|---|---|
| Full baseline | Finish existing full work; extend the scorecard [T1.27](https://github.com/SoroushRF/Rehearsal/issues/161); deploy [T2.5](https://github.com/SoroushRF/Rehearsal/issues/14) and prepare operator tasks [T2.22](https://github.com/SoroushRF/Rehearsal/issues/177) | Preserve a measured full baseline before beyond changes; full acceptance gaps below still apply |
| Shared boundary | Decision [T1.20](https://github.com/SoroushRF/Rehearsal/issues/162) then contracts/fixtures [T1.21](https://github.com/SoroushRF/Rehearsal/issues/163) | Unblocks T1 isolation/worlds, T2 API/UI, T3 persistence/admission and T4 challenges |
| Parallel implementation | T1 snapshot [T1.22](https://github.com/SoroushRF/Rehearsal/issues/166) + credentials [T1.23](https://github.com/SoroushRF/Rehearsal/issues/167); T3 storage [T3.13](https://github.com/SoroushRF/Rehearsal/issues/164) + mechanics [T3.14](https://github.com/SoroushRF/Rehearsal/issues/165); T4 challenges [T4.11](https://github.com/SoroushRF/Rehearsal/issues/169); T2 API [T2.19](https://github.com/SoroushRF/Rehearsal/issues/171) then progress UI [T2.20](https://github.com/SoroushRF/Rehearsal/issues/172) | Full-operation implementations and dual approvals gate engine reuse; API waits for storage and historical policy binding |
| Execute and verify | Runner [T3.15](https://github.com/SoroushRF/Rehearsal/issues/168) then lifecycle [T3.16](https://github.com/SoroushRF/Rehearsal/issues/170); independent verifier [T4.12](https://github.com/SoroushRF/Rehearsal/issues/173) then report UI [T2.21](https://github.com/SoroushRF/Rehearsal/issues/174) | T1 worlds/credentials feed T3; T3/T4 evidence feeds T2 |
| Final acceptance | Integrated gate [T4.13](https://github.com/SoroushRF/Rehearsal/issues/175) then final results [T1.28](https://github.com/SoroushRF/Rehearsal/issues/176) | Existing demo/submission [T2.7](https://github.com/SoroushRF/Rehearsal/issues/16) waits for final evidence and deployed URL |

`Blocked by` means a hard completion/acceptance prerequisite, not a ban on starting a fixture or contract implementation. T1.28 is staged: capture the full baseline once T1.27 is ready, then finish the beyond comparison after T4.13. This avoids postponing all measurement until the end.

## Main beyond tasks

| Task | Track owner | Blocked by | Directly blocks |
|---|---|---|---|
| [T1.20](https://github.com/SoroushRF/Rehearsal/issues/162) Decision record: executable rehearsal and its trust boundaries | @SoroushRF | [T1.16](https://github.com/SoroushRF/Rehearsal/issues/141) | [T1.21](https://github.com/SoroushRF/Rehearsal/issues/163), [T1.23](https://github.com/SoroushRF/Rehearsal/issues/167), [T3.14](https://github.com/SoroushRF/Rehearsal/issues/165), [T1.24](https://github.com/SoroushRF/Rehearsal/issues/178) |
| [T1.21](https://github.com/SoroushRF/Rehearsal/issues/163) Contracts: rehearsal jobs, scenario references, and reports | @SoroushRF | [T1.20](https://github.com/SoroushRF/Rehearsal/issues/162) | [T1.22](https://github.com/SoroushRF/Rehearsal/issues/166), [T1.23](https://github.com/SoroushRF/Rehearsal/issues/167), [T2.19](https://github.com/SoroushRF/Rehearsal/issues/171), [T3.13](https://github.com/SoroushRF/Rehearsal/issues/164), [T3.14](https://github.com/SoroushRF/Rehearsal/issues/165), [T4.11](https://github.com/SoroushRF/Rehearsal/issues/169) |
| [T1.22](https://github.com/SoroushRF/Rehearsal/issues/166) Seed disposable Era worlds from a supported incident snapshot | @SoroushRF | [T1.21](https://github.com/SoroushRF/Rehearsal/issues/163), [T1.2](https://github.com/SoroushRF/Rehearsal/issues/3), [T1.7](https://github.com/SoroushRF/Rehearsal/issues/8), [T1.13](https://github.com/SoroushRF/Rehearsal/issues/136), [T1.14](https://github.com/SoroushRF/Rehearsal/issues/137) | [T3.15](https://github.com/SoroushRF/Rehearsal/issues/168) |
| [T1.23](https://github.com/SoroushRF/Rehearsal/issues/167) Scoped rehearsal credentials and world routing | @SoroushRF | [T1.20](https://github.com/SoroushRF/Rehearsal/issues/162), [T1.21](https://github.com/SoroushRF/Rehearsal/issues/163), [T1.9](https://github.com/SoroushRF/Rehearsal/issues/39) | [T3.15](https://github.com/SoroushRF/Rehearsal/issues/168) |
| [T2.19](https://github.com/SoroushRF/Rehearsal/issues/171) API: request and read an execution rehearsal | @parsaabbasian | [T1.21](https://github.com/SoroushRF/Rehearsal/issues/163), [T3.13](https://github.com/SoroushRF/Rehearsal/issues/164), [T2.14](https://github.com/SoroushRF/Rehearsal/issues/138) | [T2.20](https://github.com/SoroushRF/Rehearsal/issues/172), [T2.21](https://github.com/SoroushRF/Rehearsal/issues/174) |
| [T2.20](https://github.com/SoroushRF/Rehearsal/issues/172) Review UI: start a rehearsal and follow its progress | @parsaabbasian | [T2.19](https://github.com/SoroushRF/Rehearsal/issues/171) | [T4.13](https://github.com/SoroushRF/Rehearsal/issues/175) |
| [T2.21](https://github.com/SoroushRF/Rehearsal/issues/174) Review UI: compare expected and observed rehearsal outcomes | @parsaabbasian | [T2.19](https://github.com/SoroushRF/Rehearsal/issues/171), [T4.12](https://github.com/SoroushRF/Rehearsal/issues/173) | [T4.13](https://github.com/SoroushRF/Rehearsal/issues/175) |
| [T2.22](https://github.com/SoroushRF/Rehearsal/issues/177) Operator task tests and findings | @parsaabbasian | [T2.5](https://github.com/SoroushRF/Rehearsal/issues/14), [T2.6](https://github.com/SoroushRF/Rehearsal/issues/15) | Evidence for operator/product claims |
| [T3.13](https://github.com/SoroushRF/Rehearsal/issues/164) Separate rehearsal persistence and durable jobs | @ArtinMe | [T1.21](https://github.com/SoroushRF/Rehearsal/issues/163) | [T2.19](https://github.com/SoroushRF/Rehearsal/issues/171), [T3.15](https://github.com/SoroushRF/Rehearsal/issues/168) |
| [T3.14](https://github.com/SoroushRF/Rehearsal/issues/165) Share deterministic execution mechanics while preserving admission boundaries | @ArtinMe | [T1.20](https://github.com/SoroushRF/Rehearsal/issues/162), [T1.21](https://github.com/SoroushRF/Rehearsal/issues/163), [T3.8](https://github.com/SoroushRF/Rehearsal/issues/134), [T1.7](https://github.com/SoroushRF/Rehearsal/issues/8), [T1.13](https://github.com/SoroushRF/Rehearsal/issues/136), [T1.14](https://github.com/SoroushRF/Rehearsal/issues/137), [T2.13](https://github.com/SoroushRF/Rehearsal/issues/135) | [T3.15](https://github.com/SoroushRF/Rehearsal/issues/168) |
| [T3.15](https://github.com/SoroushRF/Rehearsal/issues/168) Execute a stored plan against disposable worlds | @ArtinMe | [T3.13](https://github.com/SoroushRF/Rehearsal/issues/164), [T3.14](https://github.com/SoroushRF/Rehearsal/issues/165), [T1.22](https://github.com/SoroushRF/Rehearsal/issues/166), [T1.23](https://github.com/SoroushRF/Rehearsal/issues/167) | [T3.16](https://github.com/SoroushRF/Rehearsal/issues/170), [T4.12](https://github.com/SoroushRF/Rehearsal/issues/173) |
| [T3.16](https://github.com/SoroushRF/Rehearsal/issues/170) Rehearsal worker: restart, cancellation, and cleanup | @ArtinMe | [T3.15](https://github.com/SoroushRF/Rehearsal/issues/168), [T4.11](https://github.com/SoroushRF/Rehearsal/issues/169) | [T4.13](https://github.com/SoroushRF/Rehearsal/issues/175) |
| [T4.11](https://github.com/SoroushRF/Rehearsal/issues/169) Allowlisted rehearsal challenges and controls | @skhdemo | [T1.21](https://github.com/SoroushRF/Rehearsal/issues/163), [T4.2](https://github.com/SoroushRF/Rehearsal/issues/26), [T4.4](https://github.com/SoroushRF/Rehearsal/issues/28) | [T3.16](https://github.com/SoroushRF/Rehearsal/issues/170), [T4.12](https://github.com/SoroushRF/Rehearsal/issues/173) |
| [T4.12](https://github.com/SoroushRF/Rehearsal/issues/173) Independent verifier for observed rehearsal effects | @skhdemo | [T3.15](https://github.com/SoroushRF/Rehearsal/issues/168), [T4.11](https://github.com/SoroushRF/Rehearsal/issues/169) | [T2.21](https://github.com/SoroushRF/Rehearsal/issues/174), [T4.13](https://github.com/SoroushRF/Rehearsal/issues/175) |
| [T4.13](https://github.com/SoroushRF/Rehearsal/issues/175) Integrated isolation and recovery acceptance gate | @skhdemo | [T3.16](https://github.com/SoroushRF/Rehearsal/issues/170), [T2.20](https://github.com/SoroushRF/Rehearsal/issues/172), [T2.21](https://github.com/SoroushRF/Rehearsal/issues/174), [T4.12](https://github.com/SoroushRF/Rehearsal/issues/173), [T1.8](https://github.com/SoroushRF/Rehearsal/issues/9), [T2.17](https://github.com/SoroushRF/Rehearsal/issues/147) | [T1.28](https://github.com/SoroushRF/Rehearsal/issues/176) |

## Optional killer tracks

| Task | Track owner | Blocked by | Directly blocks |
|---|---|---|---|
| [T1.24](https://github.com/SoroushRF/Rehearsal/issues/178) Native Stripe sandbox setup and read conformance | @SoroushRF | [T1.20](https://github.com/SoroushRF/Rehearsal/issues/162), [T1.1](https://github.com/SoroushRF/Rehearsal/issues/2), [T1.3](https://github.com/SoroushRF/Rehearsal/issues/4) | [T3.17](https://github.com/SoroushRF/Rehearsal/issues/184) |
| [T1.25](https://github.com/SoroushRF/Rehearsal/issues/180) Competent scripted benchmark baseline | @SoroushRF | [T1.27](https://github.com/SoroushRF/Rehearsal/issues/161), [T4.14](https://github.com/SoroushRF/Rehearsal/issues/179) | Own sandbox/verification/benchmark evidence |
| [T1.26](https://github.com/SoroushRF/Rehearsal/issues/181) Precedent reuse across different incidents | @SoroushRF | [T1.8](https://github.com/SoroushRF/Rehearsal/issues/9), [T2.17](https://github.com/SoroushRF/Rehearsal/issues/147), [T4.14](https://github.com/SoroushRF/Rehearsal/issues/179) | Own sandbox/verification/benchmark evidence |
| [T2.23](https://github.com/SoroushRF/Rehearsal/issues/182) Server-side fresh verification bound to the plan | @parsaabbasian | [T2.13](https://github.com/SoroushRF/Rehearsal/issues/135), [T2.4](https://github.com/SoroushRF/Rehearsal/issues/13) | [T2.24](https://github.com/SoroushRF/Rehearsal/issues/183) |
| [T2.24](https://github.com/SoroushRF/Rehearsal/issues/183) Clerk verification UI | @parsaabbasian | [T2.23](https://github.com/SoroushRF/Rehearsal/issues/182), [T2.3](https://github.com/SoroushRF/Rehearsal/issues/12) | Own sandbox/verification/benchmark evidence |
| [T3.17](https://github.com/SoroushRF/Rehearsal/issues/184) Native Stripe sandbox refund writer | @ArtinMe | [T1.24](https://github.com/SoroushRF/Rehearsal/issues/178), [T3.8](https://github.com/SoroushRF/Rehearsal/issues/134) | [T3.18](https://github.com/SoroushRF/Rehearsal/issues/185) |
| [T3.18](https://github.com/SoroushRF/Rehearsal/issues/185) Native Stripe executor recovery gate | @ArtinMe | [T3.17](https://github.com/SoroushRF/Rehearsal/issues/184), [T3.5](https://github.com/SoroushRF/Rehearsal/issues/22) | Own sandbox/verification/benchmark evidence |
| [T4.14](https://github.com/SoroushRF/Rehearsal/issues/179) Held-out incident datasets and independent gold | @skhdemo | [T1.2](https://github.com/SoroushRF/Rehearsal/issues/3), [T1.19](https://github.com/SoroushRF/Rehearsal/issues/144) | [T1.25](https://github.com/SoroushRF/Rehearsal/issues/180), [T1.26](https://github.com/SoroushRF/Rehearsal/issues/181) |

Native Stripe is a narrow test-mode path: [T1.24](https://github.com/SoroushRF/Rehearsal/issues/178) → [T3.17](https://github.com/SoroushRF/Rehearsal/issues/184) → [T3.18](https://github.com/SoroushRF/Rehearsal/issues/185). Fresh Clerk verification is [T2.23](https://github.com/SoroushRF/Rehearsal/issues/182) → [T2.24](https://github.com/SoroushRF/Rehearsal/issues/183). Held-out data [T4.14](https://github.com/SoroushRF/Rehearsal/issues/179) feeds the strong scripted baseline [T1.25](https://github.com/SoroushRF/Rehearsal/issues/180) and cross-incident memory comparison [T1.26](https://github.com/SoroushRF/Rehearsal/issues/181). None is a hard blocker for the main beyond gate or basic final benchmark publication. Include their results only after their own gates pass; otherwise state not run.

## Additional benchmark tasks

| Task | Track owner | Blocked by | Directly blocks |
|---|---|---|---|
| [T1.27](https://github.com/SoroushRF/Rehearsal/issues/161) Extend the scorecard to the full operation set | @SoroushRF | [T1.6](https://github.com/SoroushRF/Rehearsal/issues/7), [T1.15](https://github.com/SoroushRF/Rehearsal/issues/140), [T1.7](https://github.com/SoroushRF/Rehearsal/issues/8), [T1.13](https://github.com/SoroushRF/Rehearsal/issues/136), [T1.14](https://github.com/SoroushRF/Rehearsal/issues/137), [T3.8](https://github.com/SoroushRF/Rehearsal/issues/134) | [T1.25](https://github.com/SoroushRF/Rehearsal/issues/180), [T1.28](https://github.com/SoroushRF/Rehearsal/issues/176) |
| [T1.28](https://github.com/SoroushRF/Rehearsal/issues/176) Run and publish versioned benchmark comparisons | @SoroushRF | [T1.27](https://github.com/SoroushRF/Rehearsal/issues/161), [T4.13](https://github.com/SoroushRF/Rehearsal/issues/175) | [T2.7](https://github.com/SoroushRF/Rehearsal/issues/16) |

## Full-version prerequisites and remaining acceptance gaps

The extension does not replace unfinished full work. Slack [T1.7](https://github.com/SoroushRF/Rehearsal/issues/8) waits for its review UI [T2.15](https://github.com/SoroushRF/Rehearsal/issues/145) and writer [T3.10](https://github.com/SoroushRF/Rehearsal/issues/149); public replies [T1.13](https://github.com/SoroushRF/Rehearsal/issues/136) wait for [T2.16](https://github.com/SoroushRF/Rehearsal/issues/146) and [T3.11](https://github.com/SoroushRF/Rehearsal/issues/150); balance credits [T1.14](https://github.com/SoroushRF/Rehearsal/issues/137) wait for remedy policy [T2.18](https://github.com/SoroushRF/Rehearsal/issues/148), writer [T3.12](https://github.com/SoroushRF/Rehearsal/issues/151), guard [T4.10](https://github.com/SoroushRF/Rehearsal/issues/152) and read-back [T3.8](https://github.com/SoroushRF/Rehearsal/issues/134). These gate snapshot/engine acceptance and the full scorecard. Historical policy/evidence [T2.14](https://github.com/SoroushRF/Rehearsal/issues/138) gates the new API; distinct-actor approvals [T2.13](https://github.com/SoroushRF/Rehearsal/issues/135) gate shared execution mechanics and fresh verification.

Full precedents [T1.8](https://github.com/SoroushRF/Rehearsal/issues/9) and finance promotion [T2.17](https://github.com/SoroushRF/Rehearsal/issues/147) must include application wiring: durable registry/outbox, cited plan basis and executor invalidation. A hosted adapter test alone does not satisfy the full integrated gate [T4.13](https://github.com/SoroushRF/Rehearsal/issues/175) or the optional memory comparison [T1.26](https://github.com/SoroushRF/Rehearsal/issues/181).

Before calling the selected build full, also demonstrate complete incident coverage (an omitted eligible customer is not success), a held-case refresh that creates a new revision and needs approval again, and truthful Slack final outcomes when some customer steps are held or unknown. Validate the intended batch size against planner/tool limits and case concurrency. These are full acceptance checks, not claims that this planning PR implements them or that 25 new issues automatically close every old gap.

## Release and external gates

- The selected beyond release requires [T4.13](https://github.com/SoroushRF/Rehearsal/issues/175), final measured results [T1.28](https://github.com/SoroushRF/Rehearsal/issues/176) and deployed smoke [T2.5](https://github.com/SoroushRF/Rehearsal/issues/14) before final recording/submission [T2.7](https://github.com/SoroushRF/Rehearsal/issues/16). Drafting the script and UI work can start earlier.
- Operator recruitment/consent is an external blocker on [T2.22](https://github.com/SoroushRF/Rehearsal/issues/177); actual outside use is required for user-validation or human-time claims. It does not block engine development or a submission that truthfully states no outside validation.
- Native Stripe account/test credentials and real Clerk session/configuration are external gates on their optional slices. Fixture coverage does not imply those live gates passed.
- Cut optional killer slices first if time is tight. If the team deliberately falls back to full-only, record that scope decision, remove beyond claims and explicitly revise T1.28/T2.7 dependencies in the same planning change. Do not silently waive a failed isolation or recovery gate.
- Capture evidence against the frozen submitted commit, with failures and limitations retained. A benchmark does not prove demand, production readiness or universal simulator fidelity.

## Maintaining the map

The canonical edges are the six-column task tables in [docs/tracks](tracks/). Matching issue-body links and native GitHub blocked-by relationships are filed for every new task, plus the updated T2.7 release dependencies. Keep all three aligned when changing a prerequisite. The [live blocker board](https://github.com/SoroushRF/Rehearsal/blob/status/BLOCKERS.md) renders reverse links, transitive blockers and the full status-colored graph from those tables; see [blockers.md](blockers.md).

This backlog PR records work; merging it must not close implementation issues. Implementation PRs close their own issues only after their acceptance gates pass.

