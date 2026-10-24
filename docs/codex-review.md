# Codex reviews requested from SoroushRF

The `requested-codex-review` workflow posts `@codex review` when GitHub requests
or re-requests a review from **SoroushRF**. Other reviewers, PR opens, and pushes
do not trigger it. Team review requests do not count as direct user requests.
The workflow must be merged into the default branch before it can run.

## One-time setup

1. Connect `SoroushRF/Rehearsal` to Codex under the ChatGPT account whose allowance
   should cover reviews. Keep automatic reviews off in
   [Codex review settings](https://chatgpt.com/settings/code-review).
2. As SoroushRF, create a fine-grained GitHub personal access token with access to
   **only Rehearsal**, **Pull requests: Read and write**, and an expiry date.
   GitHub includes Metadata read access. No Contents or Workflows write access
   is required.
3. Save it as the repository Actions secret `CODEX_REVIEW_GITHUB_TOKEN`. Never
   commit it. An OpenAI API key or ChatGPT login cache is not needed.
4. Merge the workflow through a PR, then request SoroushRF on a representative
   PR authored by another contributor. Check the Actions run, the comment from
   SoroushRF, and Codex's reaction and completed review.

Posting the trigger as the linked GitHub user is intended to use that user's
Codex subscription. The automated-comment path and account attribution still
need a live check; a successful Actions job proves only that the comment posted.
Do not call setup complete until Codex actually responds. The review is Codex's
feedback; it does not submit an approval as SoroushRF.

## Operation

The job verifies the token belongs to SoroushRF and rechecks that the PR is open
and still requests that user. Retrying the same workflow run does not duplicate
its comment; an explicit new review request can post another trigger. A request
that is already running is not cancelled by removing the reviewer.

The job never checks out PR code, runs PR commands, or receives product secrets.
It uses a pinned GitHub action and no permissions for the default Actions token.
The personal token can comment on PRs, so keep this workflow's trusted code under
review. Replace the secret when the token expires or is revoked.

If the comment posts but Codex does not respond, verify the GitHub connection,
manual review access, and subscription allowance before re-requesting a review.
See the [official Codex review guide](https://learn.chatgpt.com/docs/third-party/github).
