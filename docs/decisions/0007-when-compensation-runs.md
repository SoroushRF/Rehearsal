# 0007: When compensation runs (T4.4)

**Status:** proposed 2026-10-22 (T4). Please raise objections in team chat or on the PR.

## Context

The build plan says not to roll back every customer because one branch failed, and that compensation only writes owned fields back if they still hold our value. It doesn't say what counts as "failed", or whether a held step triggers it.

## Decision

1. **Trigger.** After the steps of a run, a case is compensated if one of its steps was definitely refused: a `rejected` receipt with a 4xx status other than 429. A 429 or a 5xx may be sent again by a later run, so it isn't final.
2. **Not a trigger.** A `held`, `unknown_outcome` or `skipped_dependency` step. A held case is waiting for a person, and an unknown one may have applied.
3. **Scope.** Only that case's confirmed `zendesk.ticket.patchFields` actions marked `conditional_reversible`. Refunds and notes are never undone, and other cases are untouched.
4. **Per field.** Re-read the ticket after capturing its stamp. A field that still holds our value gets its before value back through a stamp-guarded patch, journaled before dispatch. A field someone else changed is kept and gives `compensation_conflict`. A 409 on the undo only means the ticket moved, possibly in another field, so compensation re-reads and decides again, up to three rounds; if it is still changing, the patch is held. A field that has to be undone by hand makes the outcome `held` even when another field is a conflict.
5. **Never twice.** A patch with a `compensated` or `compensation_conflict` receipt is skipped, and so is one whose undo attempt already settled. An undo sent without a settled outcome (lost response, crash after dispatch) is held once and never re-sent. An undo prepared but never sent had no effect, so a fresh attempt supersedes it. So does an undo refused without a receipt (a crash between 409 rounds), since the refusal wrote nothing.
6. **The compensation receipt is final.** Once compensation records a result for a patch (`compensated`, `compensation_conflict` or `held`), later runs of that hash reuse it. Another revision copies that receipt once, pointing at the undo attempt. A patch with an undo sent but not settled is held as `unresolved_outcome`. A patch with any sent undo is never adopted as `confirmed`. An action already sent (confirmed, or with a lost response to reconcile by a read) keeps its own record even if a patch it depends on was undone since; it is never relabelled `skipped_dependency`. That exception is recovery-only: a read that finds the earlier send records it as `confirmed`, but a negative read never permits a replay or a new send, because idempotency stops a duplicate, not a send that the undone patch no longer supports. The lost send is held as `unresolved_outcome` and stays in flight, so a late landing is still found (#99). A refused attempt wrote nothing, so it is still skipped, and so is a dependent whose predecessor is held for any other reason.
7. **Same admission as any send.** No undo is sent after a cancel or once the grant is revoked, changed or expired. The patch gets an `approval_invalid` hold saying our value is still there.

## Consequences

- A refused refund also reverts its case's priority patch, since the remedy didn't happen.
- An empty before value (priority `null`) can't be written back through the typed patch, so that field is held for a manual undo.
- A lost undo response stays held for an operator. A later run doesn't reconcile it, because reconciliation is keyed by the forward write.
- Zendesk's `updated_stamp` has a documented 1-second limit, so an edit within the same second as our re-read may not 409. The receipt says so.
