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
   balance credits are enabled. Agent Memory is optional: configure its three settings
   on API (write key) and planner (read-only key) separately to enable it. Without them,
   the application reports that precedent synchronization is unavailable.

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
The complete signed-in model/review/approval/apply flow on this cloud deployment is
still unverified. Agent Memory and Slack summaries are not configured in this deployment
yet (their services/code remain available).

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
