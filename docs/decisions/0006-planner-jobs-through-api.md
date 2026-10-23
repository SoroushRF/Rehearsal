# 0006: The planner worker takes jobs and stores plans through the API (Oct 22)

## Context

T1.5 needs the planner worker to consume `plan` jobs and store the plan it produces. Jobs live in pg-boss in Postgres, and plans are rows in `plan_versions`. The executor worker connects to Postgres directly, because the journal has to be written before every dispatch.

The planner worker is the one process that runs model output. If it held `DATABASE_URL`, a bug or a prompt injection in the tool loop would be one step away from writing approval grants, runs or other orgs' plans. The planner never needs any of that. It needs exactly one job at a time and one place to hand back one manifest.

## Decision

- **No database for the planner.** `DATABASE_URL` joins the planner's forbidden credentials, and the startup check refuses it.
- **The API owns the `plan` queue.** `POST /api/incidents/:id/rehearse` checks the reviewer, picks a fresh `planId`, and queues `{orgId, incidentId, planId, requestedBy}` (`PlanJob` in `packages/providers`). `GET /api/rehearsals/:id` shows the job's state to the same org: `queued`, `planning`, `retrying` or `failed` (the last two with the last failure's reason), or `stored` (with the plan hash and the model's summary).
- **Three internal routes for the worker**, authenticated with `PLANNER_WORKER_SECRET` the same way as tenant tokens (decision 0002):
  - `POST /internal/planner/jobs/next` claims one job or returns 204.
  - `POST /internal/planner/jobs/:id/complete` hands back the manifest and the model's summary.
  - `POST /internal/planner/jobs/:id/fail` reports a reason.
- **The API checks the manifest against the job before storing it:**
  - It must parse as contracts v1.
  - It must name the job's org, plan and incident.
  - It must be revision 1 with no parent and no exclusions, with at least one step and a valid graph.
  - Anything else fails the job with `rejected_plan` and stores nothing.
  - The worker can't choose where a plan goes or overwrite one.
- **The brief comes from the incident ID**, through `incidentBrief()` in the planner. It never comes from job fields, so nothing a browser sends reaches the prompt.
- **One retry.** The queue retries a failed job once after 30 s and expires an active one after 15 minutes. A model run costs tokens, so a plan that fails twice is reported, not retried until it works.

## Consequences

- The worker needs the API running, as it already does for tenant tokens. If the API is down, the worker backs off and polls again.
- Polling every 2 s adds one cheap request per interval while idle. That's fine at hackathon scale. A push channel can replace it later without changing the job shape.
- Repeated clicks on Rehearse queue repeated runs, each with its own `planId`. Nothing deduplicates them yet.
- `/internal/planner/*` has the same exposure rule as `/internal/era/*`: a private network, or strong secrets.
