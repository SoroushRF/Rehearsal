# Native Stripe sandbox (T1.24)

An opt-in check of what the Era Stripe simulator is trusted for, against a real Stripe **test-mode** account. It is labelled `native_stripe_test`, never `era_integration`, and never stands in for an operational world ([decision 0013](decisions/0013-execution-rehearsal.md), §6).

**Status: not run.** No test key has been supplied yet. Until a run's report is attached to an issue or PR, nothing here is evidence.

## Setup
1. Use a Stripe account in **test mode** (Developers → API keys, "Test mode" on). A new sandbox is best: the run leaves its records behind.
2. Create `.env.stripe-sandbox` at the repo root. It is gitignored, like every `.env.*` except `.env.example`:
   ```bash
   STRIPE_SANDBOX_SECRET_KEY=sk_test_...
   # Optional: refuse any other account, and pin the API version the charge shape comes from.
   STRIPE_SANDBOX_ACCOUNT=acct_...
   STRIPE_SANDBOX_API_VERSION=2024-06-20
   ```
   Only a key starting `sk_test_` is accepted. Live (`sk_live_`), restricted (`rk_`) and publishable keys are refused, and so is any response with `livemode: true`.
3. Seed one run, then check it:
   ```bash
   pnpm stripe:sandbox seed
   pnpm stripe:sandbox check
   ```
   The `seed` command creates one customer (card `tok_visa`), three 42.10 CAD charges and one full refund of the second charge. Each record is labelled `metadata.rehearsal_sandbox=<run>` and sent with an idempotency key. The run's IDs go to `.stripe-sandbox-run.json`, which is gitignored. The `check` command prints the report and exits non-zero if any check fails.

   As a test: `STRIPE_SANDBOX=1 pnpm vitest run evals/providers/test/native-stripe-sandbox.test.ts`.

The command loads only `.env.stripe-sandbox`. No Era URL, admin token, worker secret or model key reaches it.

## What is checked
The same `stripeReader` the planner uses reads the records, with native auth, `starting_after` pagination and Zod response validation. It sends no Era tenant header.

| Check | Passes when |
|---|---|
| Account binding | The key's `GET /v1/account` is the account the run was seeded in, and the pinned `STRIPE_SANDBOX_ACCOUNT` if set |
| Livemode | Every customer, charge and refund has `livemode: false` and the run's label |
| Identity, amount, currency | Each charge parses as `stripe.charge.v2`, with its ID, customer, 4210 `cad`, `succeeded`, and `amount_refunded` 4210 only on the refunded one |
| Enumeration | The customer-in-window query reaches the last page at one record per page and matches exactly the three charges |

## Fidelity limits
- Test mode only: no real funds, and no operational world.
- Stripe only. Zendesk and Slack stay simulator-only.
- Reads plus a few creates. Faults, 429s and lost responses are not exercised.
- Without `STRIPE_SANDBOX_API_VERSION`, the account's default API version decides the charge shape. Newer versions may drop `charge.invoice`, which the v2 projection reads. A failed parse is then a finding, not a pass.
- Test-mode refunds can't be undone either. A run's records stay, labelled.
