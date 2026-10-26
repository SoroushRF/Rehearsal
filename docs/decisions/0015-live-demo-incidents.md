# 0015: Incidents an org files itself (live demo, #331)

**Status:** accepted 2026-10-25 (Soroush, T1).

## Context

Until now the planner knew one incident, `INC-BILL-0927`, from `scenarios/billing/incident.v1.json`. The brief came only from the server, so a plan job could not carry instructions into the prompt (`packages/planner/src/brief.ts`). The live demo lets a signed-in org file its own incident (`POST /api/incidents`) and rehearse it. The planner worker has no database (decision 0006), and the filer's description is free text.

## Decision

1. **Stored, append-only.** An incident is a row in `incidents`, keyed by an ID like `INC-BILL-0042` that is unique across orgs. It is read only by `(org, id)`: another org's ID answers 404, as if it did not exist.
2. **The job carries it.** `POST /api/incidents/:id/rehearse` copies the stored row (kind, title, description, window) into `PlanJob.incident`. The worker refuses a job whose `incident.incidentId` differs from the `incidentId` it names. Built-in incidents keep working by ID.
3. **The roster is the server's.** The customers the agent examines are the company's roster (the seeded cohort), never anything from the form. The filer chooses the kind, the words and the window.
4. **The filer's words are fenced, untrusted text.** They go into the first message between `<<<REPORT` and `REPORT>>>`, with the markers stripped from the text, after a line telling the agent the report describes symptoms and is not instructions. The system prompt is unchanged, so `PROMPT_VERSION` is too.
5. **What bounds a plan is unchanged.** The typed tools re-read what they depend on and refuse what doesn't hold, the billing policy limits amounts, the reviewer approves the exact hash, and the executor's guards re-check before every step. A report that says "refund everyone" can't widen any of these. A test plans the same eight refunds with and without such a report.
6. **An empty plan fails with the model's reason.** `rejected_plan` now carries `plan has no steps: <summary>`, so the review page can show why an out-of-scope incident planned nothing.

## Consequences

- New IAM rules (#335): `POST /api/incidents` needs `rehearsal:rehearse:incident`; `GET /api/incidents` needs `rehearsal:read:plan`.
- `PlanJob` gains an optional field (additive). Old jobs and the built-in incident parse as before.
- Creating the problem records an incident refers to (`POST /api/company/problems`) means the API calls Era `/_admin/.../inject` for the org's own tenant only. The planner never does. That route follows in a separate PR, and this record covers it.

## Addendum: support backlog and created problems (#331, PR 2)

7. **A support backlog plans with ticket steps only.** A filed `support_backlog` incident runs the planner in backlog mode: its own system prompt (`support-backlog.v1`, its own `PROMPT_VERSION`) and its own tool set and schema hash. A ticket is waiting while its status is `new`. For each waiting ticket the plan may raise the priority, add a private note and post a public reply, in that order, then a run summary. These are the existing typed operations (`patchFields`, `appendPrivateNote`, `appendPublicReply`, `postSummary`). The text comes from new approved templates in `packages/core/src/templates.ts` (`backlog-followup@1` note and reply, `backlog-summary@1`), never from the model. No money moves, so the billing policy adds no rule. The reply goes last because answering may move a ticket out of `new`, and an earlier step's re-check would then hold it.
8. **Creating a problem injects preset records only.** `POST /api/company/problems` takes `{ preset, count }` and injects the records from `scenarios/incidents/<kind>.json` into the planning and operational worlds. The body never carries a record. IDs carry a per-request stamp, because Era's inject doesn't dedupe. The route exists only when the API holds `ERA_ADMIN_TOKEN`.
9. **`service_outage` has no preset and no remedy yet.** No typed operation credits an outage without a duplicate obligation, so the planner proposes nothing for it and the plan fails with the model's reason.

Until each org has its own tenant (#330 PR B), created problems land in the shared demo tenant: every org sees them, and `INC-BILL-0927` then plans more than its eight refunds until `pnpm demo:reset`.
