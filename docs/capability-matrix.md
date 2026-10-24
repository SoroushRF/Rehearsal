# Era capability matrix (day-one gate)

These are real results from the pinned simulator containers, run on 2026-10-19 (Toronto). The checks run as code in `evals/providers/` and are skipped unless `ERA_CONFORMANCE=1`:

```bash
pnpm infra:up && pnpm smoke:era
ERA_CONFORMANCE=1 pnpm test:providers   # PowerShell: $env:ERA_CONFORMANCE=1; pnpm test:providers
```

The run covered 7 files and 33 tests, all passing, on 4 consecutive runs. The host was Windows 11 (amd64) with Docker 29.1.3 and Node 24.11.1.

**Verdict:** the core can be built on these simulators. One condition: tenants must be selected with operator-minted signed tokens, not the plaintext `X-Sim-Tenant` header (surprise 1). The Zendesk guard is a native guard with documented limits, not a CAS.

## Images and settings

| Vendor | Pinned index digest (compose) | amd64 manifest that ran | Built |
|---|---|---|---|
| `erabyeon/stripe` | `sha256:2981ee73e05ecd061a5754e87e5a3775d3e857ef29ea2a3b544de038adf0a599` | `sha256:2fc38cae60b0c330418feb7225c8d70a5fd14a01fe0ce87646e7234a8afe53ad` | 2026-10-10 |
| `erabyeon/zendesk` | `sha256:f91c3190378822f8400caf22a47e0a2107a31ba3aa912251425080829bab6444` | `sha256:ae8f43fcaa40941dfd6c75296e5746745538cbf687f9a86ffbbe8e637be4b626` | 2026-10-10 |

The amd64 manifests match the ones inspected in the audit. Both images report `ERA_IMAGE_TAG` / `build.image` = `189e10c16ec66ee1ca24ac5f7962cd7637174d0f`. Corpus schema is Stripe `v1-generation-v7` and Zendesk `v4-generation-v7`. Stripe answers with `stripe-version: 2024-06-20`.

Every world runs with `SIMCORE_SEED=42`, `SIMCORE_TODAY=2026-10-01`, `SIMCORE_STATE=day1`, `SIMCORE_FIDELITY=high`, `SIMCORE_ALLOW_CLIENT_WRITES=1` and `SIMCORE_ADMIN_TOKEN` set. There is one container per (vendor, world): Stripe on :8101/:8102 and Zendesk on :8111/:8112, all on 127.0.0.1.

## Results

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | All four worlds up and writable (`/_meta` `writes.allowed`) | **PASS** | `pnpm smoke:era` |
| a | Read-only control: the same image without `SIMCORE_ALLOW_CLIENT_WRITES` refuses a write and data stays unchanged | **PASS** | `readonly-control.test.ts` |
| b | Baseline equality, planning vs operational: charge, customer, refunds, disputes, a customer's charges, a ticket, its comments, a 100-ticket page | **PASS** (equal JSON; only pagination links differ, by origin) | `baseline.test.ts` |
| b′ | A write in planning does not reach operational, and reset restores equality | **PASS** | `baseline.test.ts` |
| c | Stripe refund with an Idempotency-Key, refetch, then exact key and bytes resent: one refund, `amount_refunded` unchanged | **PASS** | `stripe-refund.test.ts` |
| c′ | Same key with different bytes, or the same fields reordered: `400 idempotency_error`, no effect | **PASS** | `stripe-refund.test.ts` |
| d | Zendesk `safe_update` + `updated_stamp`: fresh stamp → 200 with a new stamp; stale → `409 UpdateConflict`; data unchanged | **PASS** | `zendesk-guard.test.ts` |
| d′ | No stamp with `safe_update` → `400 ParameterMissing` | **PASS** | `zendesk-guard.test.ts` |
| d″ | **Same-second limit**: a teammate write in the same simulated second keeps the stamp, so our guarded write passes and overwrites it | **REPRODUCED** (the test asserts the limitation exists) | `zendesk-guard.test.ts` |
| e | Private note: explicit `public:false` is appended, reads back `public:false`, earlier comments keep id, body and visibility | **PASS** | `zendesk-private-note.test.ts` |
| e′ | A note guarded by `safe_update`: a stale stamp gives 409 and nothing is appended | **PASS** | `zendesk-private-note.test.ts` |
| f | Tenant isolation: A's refund and ticket edit are invisible in B | **PASS with signed tenant tokens**; **FAIL with plaintext `X-Sim-Tenant`** (surprise 1) | `tenancy.test.ts` |
| f′ | `/_admin/tenants/A/reset` drops A's writes, leaves B alone, and A's token stays valid | **PASS** | `tenancy.test.ts` |
| 3 | Fixture templates match live GETs; a charge and a ticket derived from them inject and read back | **PASS** | `fixtures.test.ts`, `scenarios/billing/fixtures/` |
| T3.3 | The executor applies refund → guarded patch → private note to an operational world through the Era write adapters, one confirmed receipt per step; the note carries the operational refund ID | **PASS** (2026-10-22, macOS arm64, Docker 29.9.1; the whole suite passes there too) | `write-adapters.test.ts` |
| T3.5 | Lost responses after Era applied each write, across executor restarts: the refund is found by `metadata.rehearsal_op`, the patch by its fields, the note by its operation marker; one effect each | **PASS** (2026-10-22, macOS arm64) | `reconcile.test.ts` |
| T1.19 | Customer balance credit (`stripe.customer.balanceCredit`): a negative balance transaction under an Idempotency-Key moves `customer.balance` and reads back by ID; the same key and bytes replay with no second credit; different bytes give `400 idempotency_error`; a lost credit is found by `metadata.rehearsal_op` in the customer's list | **PASS**, with two fidelity gaps (surprise 8) (2026-10-24, Windows 11 amd64) | `stripe-balance-credit.test.ts` |
| T1.17 | Slack summary post (`slack.message.postSummary`): `chat.postMessage` doesn't deduplicate on `client_msg_id`, so an unknown post is resolved by finding its operation marker in `conversations.history` | **NOT RUN.** The contract only; the Slack worlds (`--profile full`) haven't run here yet. No-dedupe comes from inspecting the shipped source ([build-plan](source/build-plan.md)). T3.10 runs it on Era | — |
| T1.18 | Public reply (`zendesk.ticket.appendPublicReply`): `public:true` comment reads back byte for byte; the operation marker in the body finds exactly that reply; the same send again appends a second copy (no dedupe) | **PASS**, with two fidelity gaps (surprise 9) (2026-10-24, Windows 11 amd64) | `zendesk-public-reply.test.ts` |

Not covered by this gate: Era fault injection (`/_admin/faults`), Slack, pagination-boundary phantoms, and executor gates 5–7 (journal, crash recovery, ID remapping).

## Surprises

### 1. Plaintext `X-Sim-Tenant` is ignored. Every client request lands in tenant `default`.

Once `SIMCORE_ADMIN_TOKEN` is set, which compose does, simcore treats the deployment as secured (`simcore/tenancy.py` `resolve_tenant`, `simcore/operator.py` `may_select_tenant`). An unsigned tenant header from a client is then dropped, and the request falls through to `default`. In practice, `ERA_TENANT=rehearsal-demo` did nothing for client traffic. And `eraAdmin(...)` reset or injected `rehearsal-demo`, a tenant no client request ever reached.

Three things do select a tenant:

- A **signed tenant JWT**, minted by the operator from the container's own IdP: `POST /token` with `grant_type=client_credentials&client_id=…&client_secret=…&tenant=T` and the header `X-Sim-Admin-Token: <admin>`. The result is an RS256 token with `"tenant": T`, `expires_in: 3600`. Each container signs its own, so mint once per world. The token still works after a tenant reset. It can be sent as `X-Sim-Tenant: <jwt>` (what `eraFetch` now does when `WorldConfig.tenantToken` is set) or as the Bearer.
- The operator credential on the request together with a plaintext tenant. That would hand the admin token to the client path, so don't.
- Removing `SIMCORE_ADMIN_TOKEN`. That leaves `/_admin` open to anything on localhost, which breaks the planner/admin boundary.

Minting without the operator credential returns `403 access_denied`. `/_admin` without it returns `401 admin_unauthorized`.

**Changed here:** `WorldConfig.tenantToken` and `mintTenantToken()` in `packages/providers`. The workers get theirs from the API's operator route and refresh before the hour runs out ([decision 0002](decisions/0002-era-tenant-token-minting.md), T1.9).

### 2. Auth header shapes

- **Stripe** needs `Authorization: Bearer <anything>`; without it you get a 401 in Stripe's envelope. `/_meta` advertises the `sk_test_` prefix, but any value is accepted.
- **Zendesk** answers without auth as `{"user":{"name":"Anonymous user"}}`. With any Bearer (or Basic `agent@northwind.com/token:<x>`), it acts as agent `1000003`, Jodi Miller.
- **Admin** takes `Authorization: Bearer <admin>` or `X-Sim-Admin-Token: <admin>`.

### 3. Endpoint paths

- Stripe: `/v1/...`, form-encoded bodies, no suffix.
- Zendesk: `/api/v2/...json`, JSON bodies wrapped in `{"ticket":…}`. Notes go through `PUT /api/v2/tickets/{id}.json` with a `comment` field.
- Per container: `/_meta`, the IdP at the root (`/token`, `/jwks.json`), and `/_admin/tenants/{T}/{reset,inject}`.
- Zendesk `next_page` is an absolute URL on the serving world's origin.

### 4. ID formats

- **Stripe**: `ch_`, `cus_`, `pi_`, `re_`, `txn_` and `acct_` IDs, each followed by 16 alphanumerics.
- **Zendesk**: numeric, banded by kind. Agents are `100000x`, end users `20000xx`, orgs `30000xx`, groups `50000xx`. Seeded tickets start at `4000000`; tickets created at runtime start at `9000000`. Comment IDs are the ticket ID ×100 + n (`400000001`, and `9000553101` for injected ticket `90005531`). Custom fields are `7990001…`.

### 5. Twin worlds mint identical runtime IDs

The first refund was `re_TOm3JH6PbIhGMHd0` in every tenant and in both worlds. Runtime IDs come from seed, state and a counter (`stripe_sim/store.py` `mint`), not from tenant or world. A test of the ID remapper must make IDs diverge on purpose, as the audit warned.

### 6. Stripe idempotency details

- A replay returns `idempotent-replayed: true` and a byte-identical body.
- The fingerprint is path + raw body bytes: a mere field reorder gives `400 idempotency_error`.
- The cache is per tenant.
- **Reset clears the cache**: after a reset, the same key and bytes create a new refund. Never reset a world that a plan is applying in.
- Simplifications: refund creation always returns `status: "succeeded"`, and `reason` defaults to `requested_by_customer`.

### 7. Clocks

- Each world's simulated clock starts at `SIMCORE_TODAY` and moves with wall time. Zendesk writes are stamped `2026-10-01T12:00:xxZ`.
- Stripe stamps a runtime refund at `2026-10-04T12:00:02Z`, three days ahead of Zendesk.
- Seeded Zendesk tickets carry 2024 timestamps, so the first write jumps `updated_at` forward about two years.
- HTTP `Date` headers and JWT `iat` use real wall time.

### 8. Zendesk rewrites a ticket's comment timestamps on every update

Any update to a ticket, even a priority-only change, re-spreads the `created_at` of its seeded comments across the ticket's created→updated window. Comment IDs, bodies and visibility don't change. A readset fingerprint that includes comment timestamps would raise a false stale hold after our own write. Project only `id`, `body`, `public` and `author_id`.

### 9. Zendesk details

- A REST comment without `public` is **public**, so always send `public:false` explicitly.
- The 409 description names both stamps.
- The same-second collision reproduced on almost every attempt. Local requests are fast enough that two writes nearly always share a second.

### 10. Read-only refusal shape differs by vendor

Zendesk returns `403 {"error":"writes_disabled",…}`. Stripe returns the same 403 inside its own envelope: `{"error":{"type":"invalid_request_error","message":"this simulator is read-only…"}}`, with no `writes_disabled` code. Match on the status code, not the body.

### 11. Inject templates

- Stripe stores an injected charge as given, except that it re-derives `refunds.url`.
- Zendesk echoes derived fields (`url`, `raw_subject`, `description`) as given, so a template has to rewrite them along with the ID.

See `scenarios/billing/fixtures/README.md`.

### 12. Seed data vs the demo policy

Every seeded charge is **USD**, but `scenarios/billing/policy.v1.json` allows only **CAD**. With the seed as it is, every remedy would be held. Either inject CAD charges from the template or change the policy currency.

### 13. Local environment

- **Postgres:** `pnpm infra:up` exits 1 when host port 5432 is already in use (here by `wslrelay`, a WSL-side Postgres). The four simulators still start. The gate doesn't need Postgres.
- **Smoke script:** `pnpm smoke:era` printed all four OKs, then crashed on exit on Windows with a libuv assertion (0xC0000409) from calling `process.exit()` while fetch sockets were closing. Fixed by setting `process.exitCode` instead.

### 8. Customer balance credits don't check currency or amount

`POST /v1/customers/{id}/balance_transactions` takes any currency, whatever the customer's own currency is. `ending_balance` then sums the amounts across currencies into one number: a USD customer credited 100 EUR and then 100 USD shows `-200`. Stripe keeps a customer's balance in that customer's currency and refuses others. Era also accepts `amount=0`.

- **The incident cohort's customers are USD in Era, but their charges are CAD.** A CAD credit to one of them would pass on Era and fail on Stripe. Before T1.14 plans credits, each credited customer's currency has to match the credit: either seed CAD customers for the cohort, or have policy (T2.18) refuse a credit when the observed customer currency differs. Never rely on Era to refuse it.
- `StripeCustomerBalanceCredit` takes `PositiveMoney`, so a zero credit can't be planned.
- Like refunds, twin tenants mint the same transaction ID (`cbtxn_…`, surprise 5). Reconcile by `metadata.rehearsal_op`, never by ID alone.
- A credit can't be deleted. It is offset only by a new, separately approved debit, so its compensation class is `compensable_by_new_action`.

### 9. Public replies: the marker has to be in the text

A public comment keeps its `body` exactly: newlines, double spaces and non-ASCII characters all survive. Nothing deduplicates a repeated send; the same PUT twice appends two identical comments. Era also differs from Zendesk in two ways that decide where the correlation marker goes:

- Custom audit metadata (`ticket.metadata`) is accepted and dropped: the comment's `metadata.custom` stays `{}`.
- A comment sent with `html_body` alone is appended with an empty `body`.

So the marker is appended to the plain `body`, after the approved text, the same way as private notes. The customer can see it. The approved text itself (`args.body`) can't contain `[rehearsal-op:`, so a forged marker can't confuse reconciliation.
