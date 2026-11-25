# 0020: External agents, MCP staged capture, and raw plan submission

**Status:** proposed 2026-11-25 (Soroush, T1). Governs T2 API/MCP/SDK intake and T1/T4 evidence boundaries; requires review from T2 (@parsaabbasian) and T4 (@skhdemo) before implementation.

## Context

Rehearsal's durable product is the controlled approval-and-execution boundary, not only its internal billing planner. To let any external AI agent (Claude, Codex, LangGraph, custom agents) or deterministic script propose work safely, Rehearsal must accept externally generated plans without handing external callers write credentials, approval authority, or trust over risk labels.

Two capabilities exist on the roadmap: a public plan submission API (#419) and an MCP server + TypeScript client (#420). Reviewing `main` (`4fc2f19`) highlighted an important sequencing opportunity and a trap:

- **Opportunity:** `PlanningSession.call(name, input)` (`packages/planner/src/tools.ts:318`) is already a model-free typed tool API where the server performs reads, records observations, checks completeness, and builds typed actions. Wrapping it in MCP lets external agents stage plans immediately without having to construct or cryptographically prove raw evidence.
- **Trap:** `PlanningSession` alone refuses any world other than `"planning"`, hardcodes two tool catalogs (`billing` and `backlog`), and stores state in process-local private fields (`tools.ts:303-315`). It does not provide multi-tenant API authentication, persistent draft ownership, run status, typed hold reasons for replanning, or revision parity—all of which #420 requires. Conversely, raw manifest submission (#419) cannot safely accept external manifests until server-derived obligations (#438), server-derived `protection`/`compensation` labels (#429), and `PlanManifest` v2 (`T4.35`) exist so external callers cannot spoof evidence or risk badges shown in the review UI.

## Decision

Deliver external agent intake in four explicit slices across #419 and #420:

1. **Shared org-scoped intake foundation (first slice of #419).**
   - Add per-org API keys, authentication, draft ownership, rate limits (#450), and server-side validation shared by both MCP and HTTP intake.
   - Enforce a strict capability boundary: external submitter keys **never** grant approval, apply, revoke, provider-write, tenant-routing, or arbitrary HTTP privileges.

2. **MCP staged-plan capture over `PlanningSession` (first slice of #420).**
   - Expose read and `propose_*` tools over MCP backed by the org's read-only provider connection (#421 read-only slice, not fixture rosters), plus a finalize tool that compiles and stores a reviewable revision and returns its `planId`, `revision`, `planHash`, and review URL.
   - Persist staged session state on the server (scoped to the authenticated org and draft) rather than relying on process-local memory.
   - The MCP server intentionally exposes **no approve tool and no apply tool**.

3. **Raw plan / intent submission API (second slice of #419, gated on #438, #429, and `T4.35`).**
   - Accept structured intents or v2 manifests from scripts and non-MCP agents.
   - On ingestion, the server independently verifies cited evidence against the org's read-only connection, derives canonical obligation keys (#438), derives `protection`, `compensation`, and `requiredRole` from the operation registry (#429) and policy (#422), and rejects unverified or under-evidenced steps before storing revision 1.

4. **MCP status, typed holds, and revision parity (completion of #420).**
   - Expose read-only status tools returning structured receipts, obligation ledger state (#425), and machine-readable hold reasons tied to evidence so an external agent can propose a follow-up revision for held cases, which still requires fresh human approval.

5. **Precedent memory stays advisory.**
   - External agents may read active precedents or recall hints as context, but Postgres `precedent_events` remains the sole authority at approval and admission (#445).

## Consequences

- External agents can connect via MCP as soon as the read-only connection slice (#421) and shared intake auth land, without waiting for full raw-manifest verification.
- Scripts, SQL jobs, and CI pipelines get a clean, tamper-resistant HTTP/SDK path once `T4.35`, #429, and #438 are in place.
- The review UI never renders caller-invented risk labels or unverified evidence for externally submitted plans.
- Requires amending #419 (split shared auth/draft foundation from raw v2 ingestion; depend on `T4.35`) and #420 (staged capture over `PlanningSession` first, blocked by #421 read-only slice + #438 + shared intake auth rather than raw ingestion).
