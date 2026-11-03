# Render deployment (T2.5)

`render.yaml` deploys the API (including the built web UI), private IAM, three workers,
nine private pinned Era images and Postgres 17 in Ohio. The services use paid 512 MB
instances. Keep the free Hobby **workspace**; a paid workspace upgrade is not required
for these service types. Review the actual price in Render before creating resources.
The $50 promotion is a billing credit, not a spending cap. Google model usage is billed
separately to the planner's Google Cloud project.

## Configuration

The Blueprint is generated from `infra/render/blueprint.mjs`:

```sh
node infra/render/blueprint.mjs
```

JSON is valid YAML. Never edit the generated file directly. Auto-deploys and previews
are off so simulator restarts and extra deployments are deliberate. Each role has its
own explicit environment; never attach an operator or model-key environment group to
all services. Postgres rejects external connections.

1. Create a Blueprint from this repository and select the reviewed deployment branch.
2. Supply Clerk's publishable key to the API build and IAM, and its secret to IAM only.
   `CLERK_AUTHORIZED_PARTIES` must contain the public API/web origin. The API and workers
   do not receive the Clerk secret.
3. Supply the dedicated Vertex AI service-account JSON and project to the planner only.
   The account needs `roles/aiplatform.user`. Personal ADC files are refused by the
   launcher. The existing planner startup checks still run. Model calls require funding
   in Google Cloud; Render credit does not pay for them.
4. Certificates: Render assigns IAM's private hostname during creation. Generate a new
   deployment CA and leaf certificates with
   `node infra/render/certificates.mjs <actual-IAM-private-hostname>`.
   Certificate input fields are the **PEM contents**, including newlines. Copy `ca.crt`
   to `DEPLOY_IAM_CA_PEM` on API, IAM and executor. API receives `api.crt`/`api.key`,
   executor receives `executor.crt`/`executor.key`, IAM receives `server.crt`/`server.key`.
   The CA key stays in ignored `.deploy/render/certificates`; never upload it. If the
   creation form has not assigned a hostname yet, create IAM first, obtain its internal
   address, then fill the certificate fields and deploy. Certificates last 90 days.
5. For Slack summaries set the planner's `RUN_SUMMARY_CHANNEL` to a channel present in
   the seeded Slack world. Without a value summaries stay disabled. Public replies and
   balance credits are enabled.
6. Agent Memory is optional. The Blueprint asks for `SURREAL_AGENT_MEMORY_URL` and
   `SURREAL_AGENT_MEMORY_CONTEXT` on the API and the planner, plus
   `SURREAL_AGENT_MEMORY_WRITE_KEY` on the API only and `SURREAL_AGENT_MEMORY_READ_KEY`
   on the planner only. The executor and rehearsal worker get no memory setting, and
   refuse every memory key at startup. Mint the pair locally with
   `pnpm memory:keys mint <label>` (the API's write key and the planner's read key)
   and paste each straight into its one service's field;
   never commit it or put it in a shared environment group. Leave all three of a
   service's fields empty to run without memory: the application then reports that
   precedent synchronization is unavailable. Setting only some of them stops it at
   startup. To replace the pair later, follow
   [Rotating the Agent Memory keys](#rotating-the-agent-memory-keys-t155).

The launcher constructs private HTTP URLs from Blueprint host references and writes
only that service's PEM/Google files to a private temporary directory. IAM uses mTLS
on port 3443; its certificate must match Render's actual private hostname. The API
listens on port 10000. Drizzle migrations run before the API deploy starts.

## Verification and operator actions

From the API service shell, in the repository root:

```sh
node --import tsx infra/render/smoke.ts
```

The smoke checks all nine world endpoints, writability and token minting, Postgres,
IAM certificate verification and invalid-token refusal, public pages and saved replay,
and a signed-out 401. It does not prove worker startup or a complete application run.
Check the planner, executor and rehearsal worker ready logs, then sign in and run the
real plan → review → approval → apply flow and a stored-plan execution rehearsal.
Record the deployed commit and evidence level. Until these run, T2.5 remains open.

Seeding/reset is an explicit operator action. Era state is ephemeral across restarts.
Use the existing `scripts/inject/` tools from the private network; never expose admin
ports or run resets while an apply/rehearsal is active. Those tools expect URL variables,
so materialize the API's Render host references before invoking them. Preserve receipts
and approved plans in Postgres even if worlds are reseeded.

The fallback remains a Linux VM running Compose if Render cannot run the private stack.
A public saved replay is fixture evidence until replaced by an export of an actual run.

## Rotating the Agent Memory keys (T1.55)

Run these locally, in the repository root, with the operator's `SURREAL_AGENT_MEMORY_ADMIN_KEY`
in `.env`. `<label>` is the one the current pair was minted with. The old pair keeps working
until step 5, so nothing stops while the services are redeployed. Never paste a key into chat,
a ticket or a shared document: each goes from the terminal straight into its one service's field.

1. **Rotate.** `pnpm memory:keys rotate <label>` mints the next generation
   (`rehearsal-api-<label>-g<N>` and `rehearsal-planner-<label>-g<N>`) with the same grants and
   prints each key once.
2. **Set the new values in Render.** On `rehearsal-api`, replace
   `SURREAL_AGENT_MEMORY_WRITE_KEY` with the new write key. On `rehearsal-planner`, replace
   `SURREAL_AGENT_MEMORY_READ_KEY` with the new read key. Nothing else changes: the URL and
   context stay, and the executor and rehearsal worker still get no memory setting.
3. **Deploy both** services.
4. **Check the new keys are the ones in use.**
   - In Render, check the deploy replaced every instance of both services: nothing may still
     run with the old value.
   - The planner's ready log ends with `precedents on`. The API logs no "Agent Memory not
     configured" warning, and `GET /api/precedents` answers `syncEnabled: true`. If either
     reports off, fix the field and redeploy before going on.
   - Use both new keys: open a completed run's promote panel (the API's key), and plan for an
     org with active precedents (the planner's).
   - `pnpm memory:keys status <label>` lists every generation with when the service says it
     was created and last used, and says whether `--revoke-old` would go ahead. Both new keys
     should show a `lastUsedAt`, and no old key a use after them or in the last 15 minutes.
     It prints no key.

   `lastUsedAt` is a hint, not proof. On the hosted service it stayed empty for a pair that was
   used, and for another pair it was set on first use and then didn't move (gate, 2026-11-03).
   So a new key can show "never used" while it works, and an old key still in use can look
   idle. The deploy check above is what shows the old keys are free.
5. **Revoke the old pair.** `pnpm memory:keys rotate <label> --revoke-old` revokes every
   generation older than the newest pair, never the newest, and refuses if there is nothing
   older. Before revoking anything it prints the same check as `status` and refuses (exit 3)
   when a kept key shows no use, or an old key shows a use after the kept key's last use or in
   the last 15 minutes. `--force` revokes anyway: use it only when step 4's deploy check passed
   and the refusal comes from `lastUsedAt` lagging. It exits 3 if any revoke failed; run it
   again. A service still on an old key now gets 401, so check step 4 again afterwards.

If a key leaked, do the same steps without waiting between them, and revoke with `--force`:
the old keys will still look recently used. To erase one organization's
Agent Memory instead, see `pnpm memory:erase-org` in
[agent-memory.md](agent-memory.md#erasing-an-orgs-memory-t155). It is an operator command with
the admin key and the deployment's `DATABASE_URL`, and no service setting changes. Render's
Postgres rejects external connections, so against Render it has to run from the private
network; that hasn't been tried.

## Next coordinated release

For planner recovery (#284 / PR #355), deploy the API before starting the new planner worker. The new worker sends `modelAttempts` on `/internal/planner/jobs/:id/fail`; the previous API's strict schema rejects that extra field with 400, leaving the job active until expiry. The updated API accepts old workers, so API-first is the compatible rolling order. For a rollback to the previous API, stop/roll back the planner worker first. Completion diagnostics are optional and an invalid/oversized diagnostic array is discarded without rejecting a valid plan.

Deploy one reviewed commit to IAM, API/web, planner, executor and rehearsal worker. The API's existing pre-deploy migration applies `0009_incidents.sql`. Drain planning/apply/rehearsal jobs before the switch, update IAM before exposing the new API routes, and keep new work paused until all workers report ready at the selected commit. Existing stored plans and receipts remain history; create a fresh plan after the move to per-org tenants. The Era image services do not need a restart for these source changes.

For the recorded guard moment, target the actual Clerk organization explicitly from the private network:

```sh
pnpm demo:phantom --org=org_ACTUAL_DEMO_ORGANIZATION
pnpm demo:conflict --org=org_ACTUAL_DEMO_ORGANIZATION
```

`DEMO_ORG_ID` is the equivalent environment setting. Both derive exactly the workers' `orgTenant(orgId)` and print the selected tenant before accessing Era. With neither option, the legacy shared `ERA_TENANT` still applies; it is unsuitable for a signed-in org's demo. Do not reset the org after approval or before applying the phantom plan: it would remove the injected trap.

After release, run the standalone Render smoke, verify worker ready logs, and use a fresh org plan for company → create problem → file incident → plan → review → approve → apply. For the guard case inject the phantom into that same org between approval and apply, then verify the query-membership hold and unchanged planning world. Keep Slack summaries disabled until #312 is addressed; the recorded full integration gate remains unpassed (#323), and public-reply disposable rehearsals are not part of the proven cloud path.

## October 25 cloud release

Public app: https://rehearsal-api-40b8.onrender.com/app . Project: Rehearsal in the owner's
existing workspace. Initial deployed source is merge `8c82eb28561148002c4404465576b31dc72aa8b9`
(PR #313, Linux CI passed). All fourteen services report live, with Postgres separate.
The planner, executor and rehearsal worker emitted their ready/consuming logs. The
cloud operator seed succeeded: all 11 cases match between planning and operational
Stripe/Zendesk. Cloud checks established all nine worlds reachable and writable with
token minting, Postgres and IAM mTLS/invalid-token refusal. The initial IAM smoke ran
during Render's port reconfiguration and failed; a later direct mTLS probe succeeded.
The next smoke exposed a missing HTML Accept header for `/app`; navigation clients
already send it, and the smoke now does too. On `8c82eb2`, cloud job
`job-dbf4b7l9fdbs738peij0` reran the smoke with that same header correction and succeeded
at 18:08:53 UTC (14:08 Toronto): all nine worlds, DB, IAM, `/`, `/app`, health,
phantom replay JSON and signed-out plan refusal. PR #315 persists the correction.
The final API release `570d96016ce2554d19c1ed92402f13e6f8223805` (PR #315) passed
the committed standalone smoke as `job-dbf4f3ks728c73e30stg` at 18:17:10 UTC.
The signed-in cloud flow then passed with the owner's explicit approval:

- Google sign-in selected the existing Rehearsal Demo organization.
- Gemini stored `plan_69a61834-720f-4052-8561-63a73befe7d9`, revision 1, hash prefix
  `687eb2d2c1e0`: eight CAD duplicate refunds totaling 64,877 minor units, eight ticket
  priority changes, eight private notes and eight exact-template public replies.
  The three control cases were left alone, including the USD refund refused by policy.
- The owner authorized approving and applying that exact simulator revision. Run
  `run_46a5fb49-597b-4bc9-8b66-c46843c895c9` completed with **32/32 done**; all receipt
  rows reported applied and read back from the provider. Evidence: cloud Era integration,
  not real Stripe/Zendesk accounts.
- The separate disposable-world execution rehearsal refused this plan before dispatch:
  its seeder cannot rebuild `zendesk.ticket.appendPublicReply` actions. That path remains
  unverified for this manifest; the successful operational-world simulator apply does
  not establish disposable-world rehearsal support for replies.

Agent Memory and Slack summaries are not configured in this deployment yet (their
services/code remain available). Planning and operational worlds now intentionally
differ because the approved simulator apply ran; do not reset while a run is active.

Render required a card despite the credit; the owner added it. The temporary empty
Stripe form loaded after reloading Billing. The deployment uses a dedicated Google
service account with Vertex AI User on the Rehearsal project; a single 39-token probe
returned `gemini-4-argon`. Private material is in ignored `.deploy/render`; the CA key
was not uploaded. Certificates expire 90 days after issuance. Services were created
through Render's API from the Blueprint configuration; they are not yet linked to a
managed Blueprint instance. Auto-deploy is off: release changes deliberately.

Google sign-in initially requested organization creation because the real owner's user
had no memberships; Rehearsal Demo contained test users only. The owner explicitly
authorized joining that existing organization as `org:owner`; the membership was created.
No new organization, email invitation or authorization bypass was used.


## Public main restored (2026-11-03)

The owner made public `SoroushRF/Rehearsal` the development and deployment source again.
All five Git-backed services now target its `main`: `rehearsal-api`, `rehearsal-iam`,
`rehearsal-planner`, `rehearsal-executor` and `rehearsal-rehearsal`. All five are live on
`9f680627e1338a723ba788a632d07dcf2e20fe78` (PRs #408–#410), by 23:23:10 UTC.
Auto-deploy remains off; a merge alone does not release a simulator or worker.

The API receives only the Agent Memory write key, the planner only the read key; both
also receive URL/context. IAM, executor and rehearsal worker receive no memory setting.
The release keys were verified in a disposable scope: publish/readback and planner recall
passed, planner writes returned 403, and the scope was forgotten and tombstoned afterwards.
The planner's new ready log reports `precedents on`; executor and rehearsal worker each
report consuming their own queue. IAM reports its mTLS listener on 3443.

Before deploy, database reads found no active runs, rehearsals or planner jobs. The first
ten migration hashes match the public history. The private demo's `0010_world_resets`
remains in the database/history, unused by public code. Drizzle orders migrations by their
journal timestamp: public `0010_plan_recall_diagnostics` and `0011_memory_erasures` are newer,
and post-deploy readback confirms both applied and both tables exist. No migration ledger
or historical row was rewritten, and no simulator was reset.

Evidence:

- API deployment `dep-dbl6od61egvs73duikq0`; IAM `dep-dbl6pb3m8hqs73cgcpt0`;
  planner `dep-dbl6pb0m7kps739ef60g`; executor `dep-dbl6pbbm8hqs73cgcqsg`;
  rehearsal worker `dep-dbl6pbe1egvs73dulptg`.
- Post-deploy DB job `job-dbl6pb942hec739p0r8g`: succeeded; both memory tables exist,
  both expected migration hashes are recorded, and no created/retry/active jobs remained.
- Cloud smoke `job-dbl6q6142hec739p3il0`, after all five deploys: succeeded. All nine
  worlds, writability flags/token minting, Postgres, IAM mTLS/refusal, public pages,
  health, fixture replay and signed-out plan refusal passed.
- Cloud memory job `job-dbl6q60m7kps739ehlgg`: succeeded using the deployed API environment,
  publishing/readback and recalling in a disposable org scope. The operator then forgot and
  tombstoned only that probe scope.
- Full local DB suite: 2,088 passed, 141 skipped. Modern Git OpenSSL was used; the large
  local checkout used a 15 s test timeout. Typecheck, tracked-source Biome and web build
  passed. Each implementation PR also passed clean Linux CI, including plain `pnpm lint`.
- Hosted Agent Memory: final rotation/drift/disposable-erasure checks passed three
  consecutive runs; expanded app gate 6/6 passed on three final runs. Its IAM, model and
  planning-world reads are fixtures; its Postgres and Agent Memory are real.

This establishes deployment connectivity, worker startup and hosted memory behavior.
No fresh signed-in plan/review/approve/apply flow was run for this release, and it does
not establish a new Era application acceptance run. No real organization was erased.
Hosted `lastUsedAt` remains unreliable: successful timestamp checks cannot prove old keys
are idle. Rotation still requires checking every deployed instance before revocation.
