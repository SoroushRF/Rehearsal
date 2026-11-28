# 0019: Plan hash commitments, upgrade recovery, and PlanManifest v2

**Status:** proposed 2026-11-25 (Soroush, T1). Governs `packages/contracts`, canonical hashing, admission, and upgrade recovery; requires review from T2 (@parsaabbasian), T3 (@ArtinMe), and T4 (@skhdemo) before implementation.

## Context

Rehearsal promises that "what runs is what was approved," bound to `planHash`. Reviewing `main` (`4fc2f19`) revealed four ways the current v1 contract and admission flow fall short of that guarantee across deploys and schema upgrades:

1. **Schema edits mutate historical hashes (#439).** `planHash()` (`packages/core/src/hash.ts:17`) runs `PlanManifest.parse()` before canonicalizing, so adding a defaulted field to the Zod schema silently changes the hash of already-stored plans and causes admission to refuse them.
2. **A schema change can strand in-flight sends.** Both ordinary admission and the read-only reconcile pass parse stored manifests with the *current* `PlanManifest` schema (`packages/core/src/executor.ts:557, 658`). If parsing fails after an upgrade, the run ends `failed` with no read-back, and the reaper never revisits `failed` runs (`packages/db/src/runs.ts:92`), leaving a committed refund without a receipt.
3. **The hash names rules it does not bind.** Policy files, note/reply/summary templates (`packages/core/src/templates.ts`), writer/reconciler code, and target provider account identity live outside the hash. Even where v1 already stores data, admission ignores it: `approval_grants.policies` is persisted (`packages/db/src/schema.ts:83`) but dropped by `toApprovalGrant()` (`packages/db/src/apply-store.ts:7`), and `versions.adapters` (`apps/planner-worker/src/main.ts:114`) records read projection IDs (such as `stripe.charge.v2`) rather than writer or reconciler versions—and is never checked at admission.
4. **Demo billing assumptions are baked into `CONTRACTS_VERSION = 1`.** `PlanManifest` requires `versions.planner`, hardcodes `target.environment: "operational"`, `Currency: "cad"`, three vendors, two roles, three refund `ResultPath` values, and caller-supplied `protection` and `compensation` labels (`packages/contracts/src/plan.ts`, `common.ts`, `actions.ts`). Five open roadmap items each need breaking contract changes.

## Decision

1. **Pin canonical bytes and golden hashes first (#439, T4.30).**
   - Validate `packages/core/src/canonical.ts` against the official RFC 8785 test vectors (numbers, string escaping, UTF-16 key ordering).
   - Commit golden manifests, expected canonical bytes, expected hashes, and golden `operationKey` vectors per manifest version; fail CI if any golden value drifts.
   - Hash stored canonical bytes under a retained versioned v1 decoder so future schema additions never invalidate stored plans.

2. **Recover in-flight sends across schema upgrades (`T3.42`).**
   - Persist enough versioned recovery context with each attempt (original operation key, provider account/vendor metadata, and action-kind recovery parameters) so a read-only reconcile pass can read back and settle an in-flight send even if the current manifest schema cannot parse an older stored plan.
   - Surface unresolved in-flight attempts to operators even when a run has reached a terminal state (coordinating with #453).

3. **Enforce every commitment available in v1 (`T4.34`).**
   - Expose `policies` on `ApprovalGrant` via an additive contracts PR (cross-track reviewed) and preserve it in `toApprovalGrant()`.
   - At admission, compare the running deployment's policy content, template rendering definitions, and available read-projection versions against the approved commitments, refusing on same-name, same-version content drift. Define explicit fail-closed or documented legacy handling for older rows lacking snapshots.

4. **Batch all breaking contract changes into one `PlanManifest` v2 bump (`T4.35`).**
   - Gate `T4.35` on #439 and `T3.42`. Land the v2 contract and dual v1/v2 readers first; roll out v2 writers only after mixed-version verification and upgrade-recovery tests pass.
   - Bind inside the v2 hash:
     - verified logical provider account identity (stable across credential rotation; invalidated if a connection is retargeted to a different account);
     - content digests of the policy bundle, template definitions, and writer/reconciler semantics;
     - generalized producer metadata (supporting non-AI scripts and external MCP/API submitters without requiring `versions.planner`), extensible operation/result bindings, and server-derived `protection`/`compensation` fields (no longer caller-trusted).
   - Keep feature expansions such as multi-currency (#426) off the v2 migration's critical path (blocked by `T4.35`, not folded into it).

5. **Offline TypeScript verification CLI (`T4.36`, after #439).**
   - Ship a standalone TypeScript CLI (`rehearsal check` / `rehearsal verify`) that validates v1/v2 plans against schema, DAG, and policy rules, recomputes canonical hashes, and verifies hash-chained receipt exports (#436) against an externally retained checkpoint—with no server and no provider credentials.
   - Once #439's canonical byte format is frozen, a future Rust/WASM verifier can hash exported canonical bytes directly without re-implementing Zod.

## Consequences

- Stored v1 plans remain verifiable, reconcilable, and recoverable across upgrades without a big-bang rewrite.
- Editing a policy file or template in place without bumping versions can no longer silently alter what an already-approved hash executes.
- Consolidating breaking changes into one v2 bump avoids five consecutive contract migrations across #419, #422, #426, #429, and #438.
- New tasks required (pending T3/T4 owner agreement): `T3.42`, `T4.34`, `T4.35`, `T4.36`; amended existing issues: #422, #426, #436, #439.
