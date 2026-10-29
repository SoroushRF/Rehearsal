# 0016: Repairing a held run (T1.37, #283)

**Status:** accepted 2026-10-29 (Soroush, T1). Touches executor-facing semantics, so a post-merge review from T3 or T4 is requested.

## Context

When the executor holds a step, the plan is left partly applied. A phantom is the main case: a new charge on the same invoice appears after approval, so the refund is held and the note waiting on it is skipped. Resuming the same revision holds it again, because the approved evidence is still stale. The planning world can't help either, because the phantom exists only in the operational world. Someone has to plan the rest again, and a person has to approve it again, without sending anything that already went out.

The executor already supports this. An operation key is stable across revisions of a plan (it covers the action ID, kind, obligation and target). A step whose key has a confirmed attempt with the same content is adopted, "not re-sent", and its receipt and bindings carry over. The one-remedy guard checks every revision of the org.

## Decision

1. **`POST /api/plans/:id/repair` takes `{runId, revision, planHash}`, and nothing else.** The revision must be the latest one, and the run must belong to it. No run of the plan may still be applying. The person needs `rehearsal:rehearse:incident`, since a repair spends model tokens like any rehearsal. The rule is added to `rehearsal-authz.v1`, the same way the live-demo routes were.
2. **Scope comes from the journal, never from the request** (`repairScope` in core). For each step, the latest receipt for the hash decides:
   - Confirmed: **kept**.
   - Skipped, held because a predecessor didn't go out, or never ran: **replanned**.
   - Held because new records matched its query: **replanned**, and those records are **refreshed**.
   - Anything else is refused with a reason:
     - an unknown outcome or a send in flight (resume the run to reconcile it);
     - rejected or undone;
     - a changed row;
     - a record that left the query.
   - The run summary is never kept; the repair's run gets its own summary, with its own ID.
3. **Refresh copies only what the executor reported.** For each record in a `query_membership_changed` hold, the API (the operator, holding the admin token) reads the record from the org's operational tenant. If the planning tenant lacks it, the API injects it there, under the org-world lock. The planner still never holds operational credentials.
4. **The planner plans only the open cases** (`PlanJob.repair`). The confirmed steps are adopted into the session byte-for-byte, together with the evidence they cite. Proposing one of them again is refused. The brief lists what was kept and why the rest stopped, and the coverage check runs on the open cases' customers.
5. **The API checks the result against its own stored copy** (`checkRepair`), not the job's:
   - the revision is base + 1;
   - the base is still the latest revision, and the run's scope is unchanged;
   - every kept step and its evidence are identical to the base's;
   - every other step belongs to an open case or is the summary;
   - nothing a reviewer excluded comes back.
6. **A repair is an ordinary revision.** It has a new hash and needs a new approval. Apply re-checks everything as usual. The kept steps are adopted from the journal and never re-sent; a send would need the same operation key with different content, and that is held as `approval_invalid`.

## Consequences

- Phantom demo: the repair refunds both the held duplicate and the phantom, and notes both, while the priority patch and every other case are adopted. Covered by `packages/planner/test/repair.test.ts` (real tools and executor on fakes) and the real-Postgres route tests in `apps/api/test/rehearse.test.ts`. Evidence is `fixture`; it has not run on Era.
- A held row change (a teammate's edit) is not repairable yet, because the planning copy can't be updated in place. Those cases are refused, never silently replanned on stale data.
- Approval roles are computed over the whole revision, kept steps included, so a repair of a plan with finance-level refunds still needs a finance lead.
- The review UI (T2) can show the kept steps as already applied, using the route's `kept` and the parent revision's receipts. Nothing in the UI is required for safety.
