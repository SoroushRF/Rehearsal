# 0006: When compensation runs (T4.4)

**Status:** proposed 2026-10-22 (T4). Please raise objections in team chat or on the PR.

## Context

The build plan says not to roll back every customer because one branch failed, and that compensation only writes owned fields back if they still hold our value. It doesn't say what counts as "failed", or whether a held step triggers it.

## Decision

1. **Trigger.** After the steps of a run, a case is compensated if one of its steps was definitely refused: a `rejected` receipt with a 4xx status other than 429. A 429 or a 5xx may be sent again by a later run, so it isn't final.
2. **Not a trigger.** A `held`, `unknown_outcome` or `skipped_dependency` step. A held case is waiting for a person, and an unknown one may have applied.
3. **Scope.** Only that case's confirmed `zendesk.ticket.patchFields` actions marked `conditional_reversible`. Refunds and notes are never undone, and other cases are untouched.
4. **Per field.** Re-read the ticket after capturing its stamp. A field that still holds our value gets its before value back through a stamp-guarded patch, journaled before dispatch. A field someone else changed is kept and gives `compensation_conflict`. A 409 on the undo means the ticket moved after the re-read, which is also `compensation_conflict`.
5. **Never twice.** A patch with a `compensated` or `compensation_conflict` receipt is skipped. An undo attempt without a settled receipt (lost response, crash) is held, never re-sent.
6. **Same admission as any send.** No undo is sent after a cancel or once the grant is revoked, changed or expired.

## Consequences

- A refused refund also reverts its case's priority patch, since the remedy didn't happen.
- An empty before value (priority `null`) can't be written back through the typed patch, so that field is held for a manual undo.
- A lost undo response stays held for an operator. A later run doesn't reconcile it, because reconciliation is keyed by the forward write.
- Zendesk's `updated_stamp` has a documented 1-second limit, so an edit within the same second as our re-read may not 409. The receipt says so.
