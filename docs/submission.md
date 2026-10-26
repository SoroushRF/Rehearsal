# Submission kit: two-minute video and Devpost (T2.7)

**Status: draft, written 2026-10-25.** It is not final until the deployed URL (T2.5) and the final benchmark (T1.28) exist. Everything marked **[fill]** has to be replaced then. Every claim below points at the file or test that backs it; if you can't point at one, don't say it.

Deadline: Oct 25, 11:59 PM ET. The brief says submit in the afternoon. Public repository, a public two-minute video, a live link where it applies, stack and partner use, and AI-tool disclosure ([build plan §13](source/build-plan.md#13-current-event-facts-and-resource-gates)).

## The one-line pitch

**Terraform plan for AI agents doing batch operations.** The agent plans inside a simulated copy of the company. A reviewer approves the exact plan once, bound to its hash. A deterministic executor with no model applies it, re-checking each step first and holding anything that went stale.

Closing line (proposed in [0001](decisions/0001-open-team-decisions.md), not yet settled by the team): **"Rehearse the plan. Approve its effects. Apply with evidence."** Do not use the brief's "Eon recovers it": we don't build recovery.

## Two-minute script

About 250 spoken words. Shots are in the order to record them. The live app screens are the review page at `/app`; the saved replay is `/?replay=phantom`.

| Time | Shot | Say |
|---|---|---|
| 0:00 | Title card, then the landing page headline | "Agents that write to production fail in ways nobody reviews until it's too late. Per-call approval asks a human dozens of times with no view of the whole job. Rolling back afterwards can't unsend an email." |
| 0:15 | The two-worlds diagram on the landing page | "Rehearsal separates deciding from doing. The model plans in a copy of the company. Production never sees the model, only a recorded, approved plan." |
| 0:28 | Review page: plan grouped by customer, plan hash in the corner | "Here is a billing bug: eight customers charged twice. The agent has planned the refunds, the ticket updates and the notes. Everything is exact: integer money, what can be undone, how well each write is protected, and the evidence behind it." |
| 0:50 | Untick one customer; the dependent note drops; a new hash appears | "Uncheck a customer and their note drops with them. That's a new revision with a new hash. Refunds over the threshold need a finance lead, and a second person where policy asks for two." |
| 1:10 | Approve once; the approval panel shows the hash it is bound to | "One approval, bound to this exact plan. Change one byte and it no longer applies." |
| 1:18 | Apply; run timeline fills in with receipts | "Now a deterministic executor, with no model and no model key, applies it. Before every step it re-reads what the step relied on." |
| 1:30 | Phantom: a new duplicate charge appears after approval; that step shows Held with the reason | "Between approval and apply, a new matching charge appeared. The approved plan didn't account for it, so that refund is held, with the reason on the receipt, and so is the note that depends on it. Everything else went through." |
| 1:50 | Receipts, then the scorecard table | "On the same twenty-eight tasks, with real Era simulators: direct writes confirmed fourteen, per-call approval nineteen, Rehearsal twenty-seven, with no invalid allows and no duplicates, and fifty-one signatures against six hundred and twenty-seven modelled per-call approvals." **[fill: confirm against the final T1.28 run]** |
| 2:00 | Closing card | "Rehearse the plan. Approve its effects. Apply with evidence." |

Cut to fit: drop the second-person line at 0:50 first, then the scorecard sentence. Keep the phantom hold; it's the moment.

### Recording notes

- Use `pnpm demo:reset`, then rehearse and approve in the live app; run `pnpm demo:phantom` between approving and applying for the real phantom. If the deployment isn't up, record against local Era and say "local simulators" on the card.
- The saved replay (`/?replay=phantom`) is a **fixture** made by running the real executor engine on a fake provider. If you cut to it, its banner says "Saved replay, not live"; leave the banner in frame.
- Show the "Fixture" or "Ran on Era" chip on the plan page when it is visible, rather than hiding it.
- Captions on, no music with lyrics, 16:9, public (unlisted doesn't count for the stricter Luma wording).

## What we can claim, and what backs it

| Claim | Backed by | Evidence level |
|---|---|---|
| Plans are checked against a canonical hash; approval is for one exact hash; changed hash or revision is refused | `packages/core` hash tests, `apps/api/test/approvals.test.ts` refusal matrix | tests (Postgres in CI) |
| The executor has no model and no model key; the planner has no operational URLs or Era admin token | credential checks at worker startup, `apps/*/test/credentials.test.ts` | tests |
| A new matching record after approval holds the step and its dependents | `evals/providers/test/phantom.test.ts` | `era_integration` |
| A teammate's edit survives; the undo is skipped with a recorded conflict | `evals/providers/test/compensation.test.ts` | `era_integration` |
| A lost response is reconciled through reads and never blindly re-sent | `evals/providers/test/reconcile.test.ts` (every write's response lost across three restarts; each applied once) | `era_integration` |
| An agent plan was approved in the UI and applied 24 of 24 steps | #131 (live run with a real model) | `era_integration`, one run |
| Two different people are required where policy v3 asks | `packages/core/test/approvals.test.ts`, executor admission tests, [0011](decisions/0011-two-distinct-approvers.md) | tests; no plan cites v3 yet |
| A past run opens with the policy it was approved under | `apps/api/test/audit.test.ts` | tests |
| Scorecard: 28 tasks (14 benign controls, 14 traps), three modes | `evals/scorecard/results/latest.txt` | `era_integration`, **scripted planner** |

### The scorecard, honestly

Scripted planner (`latest.txt`, pinned Era images, 2026-10-25, commit `bae6c2e`, after the note/reply guard fix T4.27):

| | Direct | Per-call | Rehearsal |
|---|---|---|---|
| Confirmed success | 14/28 | 19/28 | 27/28 |
| Benign controls | 14/14 | 14/14 | 14/14 |
| Traps | 0/14 | 5/14 | 13/14 |
| Invalid allows | 26 | 14 | 0 |
| Duplicates | 5 | 3 | 0 |
| Wrongful holds | 0 | 0 | 0 |
| Omitted obligations | 4 | 4 | 4 |
| Reviewer actions | 0 | 627 | 51 |
| Write-phase latency (s) | 9.5 | 9.8 | 17.8 |
| Era API calls (write phase) | 841 | 824 | 2,790 |

This run predates later merges to `main`. The final T1.28 run on the tagged submission commit replaces it **[fill]**.

- The per-call reviewer is **modelled**, not a person; so are the counts of reviewer actions. Say "modelled".
- Rehearsal's one failure is F7: the agent leaves customer c05 out of the plan, and every mode fails it. The executor can't see an omission. Since T1.30 the plan is flagged as incomplete before approval, with zero writes (`coverage-f7.txt`), but it still counts as a failure, not a success.
- Rehearsal is slower and reads more: about 1.9× the write-phase time and 3.3× the Era calls of direct writes, because it re-reads each step's assumptions first. Both were measured one case at a time. Say so if asked.
- With a real model as planner (`model-gemini-4-argon.txt`, 20 tasks, 2026-10-24, **before** the T4.27 guard fix): Rehearsal confirmed 17/20 with **zero invalid allows**, but there were 26 wrongful holds; 18 plans were made, one had no steps and one failed (a failed plan is never stored, so nothing is applied). Direct writes confirmed only 2/20. **If the video shows the scripted numbers, the Devpost text must show or link the model numbers too.**
- Don't cite the Gemini full-operation run (`model-gemini-4-argon-full-ops*.txt`, 5/8): its scorer doesn't yet separate planner failures from holds. That fix (T1.31) is measurement work for after the deadline.

## What we must not say

- That this is a real bank, a real Stripe or Zendesk account, or a compliance claim: both worlds are Era simulators. Native Stripe sandbox evidence exists only if T1.24 and T3.17 finish and are labelled separately.
- That rollback or recovery exists. A refund or an appended note is never "rolled back"; only owned fields are conditionally restored.
- That a model gates execution, or that any ML model was trained or served: out of scope ([0008](decisions/0008-ml-out-of-hackathon-scope.md)).
- That the human reviewer numbers are measured: they are modelled. No outside operator has used it yet (T2.22).
- That precedents are live end to end. Plans can cite precedents (T1.29), the review page shows each citation with its trace, approval refuses a changed precedent (T2.17), and executor admission re-checks citations against the Postgres registry (#258). The memory gate passed 6/6 on the hosted Agent Memory service (T1.8), and promotion ran there once in a throwaway scope. But the planner's recall has not run against the hosted service, so a plan citing a precedent is `fixture` evidence.
- The two statistics (PocketOS, Georgian) must be quoted exactly as in the brief, and checked against their original sources first. PocketOS: the founder reported about 30 hours of disruption; Railway restored backups within about 30 minutes of being contacted. Don't say permanent loss or 30 hours of hard downtime.

## Devpost text (draft)

**Tagline:** Terraform plan for AI agents doing batch operations.

**Inspiration.** Agents that write to production fail in ways no one reviews until it is too late. Approving every call interrupts a human dozens of times with no view of the whole job, and cleaning up afterwards can't unsend a message or may wipe legitimate edits made since. We wanted the review to happen once, on the whole plan, and the execution to be something you can trust without trusting a model.

**What it does.** A support or finance team gets a billing bug: customers charged twice. The agent plans the remedies inside a simulated copy of the company (Era). A reviewer sees the whole job grouped by customer, with exact money, how reversible each step is, how well each write is protected, and the evidence behind it. They can drop a customer (their dependent note drops too), and finance must sign refunds above a threshold. They approve once, bound to the plan's hash. A deterministic executor with no model applies exactly that plan to a separate operational world, re-checks each step's assumptions first, holds any step whose assumptions went stale, and writes a receipt.

**How we built it.** TypeScript throughout. Zod contracts at every trust boundary; an RFC 8785 canonical hash; Fastify API and a React review UI; Postgres with an append-only journal (the exact request bytes and idempotency key are stored before anything is sent; an unknown outcome is reconciled through reads, never re-sent blindly); pg-boss for jobs; Clerk for sign-in and roles; two workers with separate credentials (the planner has a model key and the planning world only, the executor has the operational world only). Typed operations only: no arbitrary URL, method or patch tools.

**Challenges.** Honest partial outcomes (a refund is never "rolled back"); ID divergence between the rehearsed world and production (the note carries the production refund ID, never the rehearsed one); throttling and lost responses; keeping the planner and the executor from ever sharing credentials.

**Accomplishments.** Phantom, teammate-edit conflict, throttled refunds and a lost response all pass against pinned Era images **[fill: link the final run]**. On 28 traps and controls with a scripted planner, Rehearsal confirmed 27, with no invalid allows and no duplicates, against 14 for direct writes and 19 for modelled per-call approval (see the scorecard and its caveats). **[fill: confirm against the final T1.28 run.]**

**What we learned.** Approval is not authorization: an approval has to be typed state tied to an exact hash, and the thing that applies it has to re-check the world. A trap the agent never sees is more instructive than one it does.

**What's next.** Two-person approval by policy, a past-run audit view, and precedents that finance promotes after a run are built; execution rehearsal in disposable worlds is next. Native Stripe sandbox proof and real operator testing are not done.

**Built with.** TypeScript, Node, React, Vite, Tailwind, Fastify, Zod, Postgres, Drizzle, pg-boss, Clerk, Playwright, Vitest, Biome, Era (Stripe and Zendesk simulators), Anthropic and Gemini models for planning, SurrealDB Agent Memory (precedents, if configured) **[fill: confirm what actually shipped]**.

**Disclosures (fill in truthfully).** AI coding tools were used to write parts of this repository **[fill: which, by whom]**; prior work: **[fill]**. Partner services actually used: **[fill]**. No ML model was trained or served.

## Judges trying it live

Each judge gets their own company only if they are in their own organization:

- Give judges the **sign-up link**. On first sign-in Clerk asks them to create an organization; that org gets its own Era tenants, seeded with the demo company, and its own plans, approvals, runs and receipts. Nothing they do reaches another org.
- **Never** share one demo login, and never invite a judge into our org: people in one org share everything, on purpose.
- **Reset** (next to *Create problem*) puts their own world back to the seeded company. It is refused while one of their plans or runs is in progress.
- Nobody runs `pnpm demo:fault` while judging. Era faults are container-wide and would hit every org; the script refuses a non-local Era unless `REHEARSAL_SHARED_FAULTS=1`.

Evidence: `evals/providers/test/org-tenant.test.ts` passes on local Era images. It checks per-org seeding, that a refund, a created problem or a reset in org A leaves org B unchanged, and that the operator mints no token for an org without a live job.

## Before recording

- [ ] Deployed URL up and `pnpm smoke:*` passing against it (T2.5) **[fill: URL]**
- [ ] `?replay=phantom` opens signed out on the deployed URL
- [ ] Final scorecard from T1.28 replaces the numbers above, scripted and real-model both
- [ ] A one-line `docs/` or README pointer to this kit and to `evals/scorecard/results/`
- [ ] Repository public; no `.env`, keys or tokens committed
- [ ] Devpost "built with", disclosures and the video link filled; tag `submission` after submitting
