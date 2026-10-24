# Codex review admission

Normal use: request **SoroushRF** as a reviewer, self-review the change, and add
**ai-review-ready**. The dispatcher waits for a non-draft PR and successful
`ci.yml` for the current head. Removing SoroushRF cancels an ordinary queued
request. Removing readiness pauses it. Pushes update a pending request's head;
there is no automatic review of later pushes after the request was dispatched.
Re-request review or remove/re-add the readiness label to queue a new request.

## Usage policy

- At most **12 starts per rolling 5 hours**, across this repository. No daily or
  separate hourly limit. Overrides also count against subsequent normal starts.
- A **60-minute per-PR cooldown** applies to normal requests.
- A commit already dispatched by this workflow is not automatically reviewed again.
- An approximately 10-minute scheduled sweep drains deferred work after CI is green.
  CI completion does not launch a token-bearing sweep. GitHub schedules can be
  delayed. Oldest PRs are considered first.
- Queue comments are display only; changing or deleting them grants no permission.
- The queue comment and workflow summary say **not reviewed** while deferred.
  Dispatch only requests a review; it is not an approval or a completed review.

Only **SoroushRF**, verified by immutable GitHub user ID **98989697**, may post this
exact, unedited top-level PR comment:

```text
/codex-review-now
```

It bypasses the quota, cooldown, duplicate-commit check, and normal request/label
requirements. It still waits for non-draft and successful current-head CI. An
owner command stays pending until then. Re-running the workflow cannot reuse a
consumed command; multiple pending owner commands coalesce into one latest request.
Other users' commands and quoted/edited commands cannot grant an override.

## Setup and safety

1. Keep automatic reviews off in [Codex review settings](https://chatgpt.com/settings/code-review).
2. Create the `codex-review` Environment (Settings → Environments) with deployment
   branches limited to `main`, and store the token there, not as a repository secret.
   A repository secret is readable by any write collaborator's `push` or same-repo
   `pull_request` workflow; an environment limited to `main` is not. The job runs with
   `environment: codex-review`, and its triggers all run in the default-branch context.
   Delete any repository-level `CODEX_REVIEW_GITHUB_TOKEN`.
   The token is a fine-grained SoroushRF token named `CODEX_REVIEW_GITHUB_TOKEN`, restricted to
   Rehearsal, with **Pull requests: Read and write** and **Commit statuses: Read and
   write** (plus implicit Metadata read). The status permission is new: the old
   pull-request-only token is insufficient. No Contents, Variables or Administration
   write permission is needed. A failed/unacknowledged reservation sends no trigger.
   No OpenAI API key or ChatGPT login cache is used.
3. Merge the workflow through a PR after the required cross-track review. Its code
   and script are always loaded from the default branch, never the PR branch.
4. Test a representative ready PR authored by another contributor: request, CI,
   queue/dispatch comment, then Codex's completed review. Until then the full
   admission path remains fixture-tested, not live-verified.

The narrow personal token writes comments; the default Actions token only reads
code and CI. There is no PR checkout, PR dependency install, or product-secret access.
Only Zod is installed for runtime validation, using the committed npm lockfile and
integrity hash, with lifecycle scripts disabled.
Pinned actions run the TypeScript directly on Node 24. Global Actions concurrency
serializes budget decisions. GitHub timelines reconstruct ordinary requests; exact,
unedited owner commands survive while they remain on the PR. REST timestamps and
GraphQL `lastEditedAt` reject edited commands, including same-second edits.

The authoritative ledger is the full history of owner-created commit statuses on
the repository's root commit (`LEDGER_SHA` in `scripts/ci/codex-review.ts`). These
records are append-only: another writer can append a status under their own identity,
but cannot edit/delete an existing status. Only the token's holder can create one as
SoroushRF, so the ledger is as safe as the token. Anyone who can merge to `main` can
change this workflow and read the token, and `main` requires only the `check` status,
so they are trusted with this budget. A forged status is permanent until
`LEDGER_CONTEXT` or `LEDGER_SHA` changes. We enumerate
all historical statuses, not the combined/latest context result. A daily context
avoids accumulating GitHub's 1,000-status-per-SHA/context cap over the project lifetime.
The status's `success` means **reservation recorded**, never review completed/approved.

Each reservation consumes its request/override and counts against the budget **before**
the trigger POST. A crash before the POST, a lost response or a deleted trigger never
causes an automatic re-post. Inspect the PR's Codex activity; if no review started,
an explicit new owner command may spend a new reservation. An unacknowledged ledger
write stops the sweep until it can reload the ledger. PR-local read/parsing/comment
failures hold that PR and allow the others to proceed; corrupt shared authoritative
ledger state fails closed globally. Queue/receipt comments are never ledger authority.

Fork ready/CI events cannot directly start token-bearing sweeps. A ready, requested
fork PR can be picked up by the scheduled sweep or an owner command. When GitHub
omits fork PR associations on a CI run, the gate also requires the exact head SHA,
head repository and head branch. Unrelated PR timelines aren't fetched.

Queued work is rechecked for the latest head immediately before dispatch. A push can
still race the subsequent comment: compare the head in Codex's **completed review**
with the current PR head. The reservation records the requested head. CI is a
readiness signal (a PR may change its own CI/AGENTS.md), and model reviews remain
advisory; neither is an authorization to merge a risky unreviewed change.

The cap always counts workflow reservations, including closed PRs and uncertain
dispatches. Visible manual SoroushRF-authored `@codex review` comments conservatively
consume additional capacity, but manual comments remain outside this workflow's
guarantees: edits/deletion may change that extra count. They cannot erase workflow
reservations. The workflow cannot prevent direct invocations of Codex. These limits
bound controlled requests, not exact token spend or total account usage. It does not
cancel already-running hosted reviews or configure their model/reasoning effort.
See the [official Codex review guide](https://learn.chatgpt.com/docs/third-party/github).
