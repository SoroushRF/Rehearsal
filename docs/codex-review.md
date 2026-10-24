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
- CI completion and an approximately 10-minute scheduled sweep drain deferred work.
  GitHub schedules can be delayed. Oldest PRs are considered first.
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
2. Store a fine-grained SoroushRF token as `CODEX_REVIEW_GITHUB_TOKEN`, restricted to
   Rehearsal and **Pull requests: Read and write** (plus implicit Metadata read).
   The secret's presence was verified October 24; runtime permissions still need
   a live check. No OpenAI API key or ChatGPT login cache is used.
3. Merge the workflow through a PR after the required cross-track review. Its code
   and script are always loaded from the default branch, never the PR branch.
4. Test a representative ready PR authored by another contributor: request, CI,
   queue/dispatch comment, then Codex's completed review. Until then the full
   admission path remains fixture-tested, not live-verified.

The narrow personal token writes comments; the default Actions token only reads
code and CI. There is no PR checkout, PR dependency install, or product-secret access.
Only pinned Zod is installed for runtime validation, with lifecycle scripts disabled.
Pinned actions run the TypeScript directly on Node 24. Global Actions concurrency
serializes budget decisions; GitHub timelines and owner-authored comments persist
requests even when pending jobs are replaced. The trigger comment itself is the
dispatch ledger, so a lost response is reconciled by reading before another post.
Queued work is rechecked for the latest head immediately before dispatch.

The ledger counts SoroushRF-authored `@codex review` trigger comments, including
manual comments, on open or closed PRs. It cannot prevent someone from directly
invoking Codex outside this workflow. These limits bound requests, not exact token
spend or total account usage across other repositories. The workflow does not
cancel already-running hosted reviews or configure their model/reasoning effort.
See the [official Codex review guide](https://learn.chatgpt.com/docs/third-party/github).
