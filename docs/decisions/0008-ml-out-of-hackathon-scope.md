# 0008: ML is out of the hackathon scope (T4)

**Status:** accepted 2026-10-24 (Sepehr, T4). Please raise objections in team chat or on the PR.

## Context

The Oct 21 trim said the ML experiment still finishes as a report ([plan.md](../plan.md#trim-decision-oct-21-evening)). That experiment is T4.5–T4.7: a LoRA smoke test, a pilot go/no-go, and an impact service behind `ImpactPort`. The core product does not depend on it. [0009](0009-reopen-full-scope.md) brings the full scope back and leaves ML out of both scopes. The remaining time goes to those features. PR #102 is the unmerged smoke-test attempt.

## Decision

1. **T4.5 (#29), T4.6 (#30) and T4.7 (#31) are deferred past the hackathon.** They are not current work. Nothing else is blocked by them. Shadow sampling is out with them.
2. **The trim line "The ML experiment still finishes as a report" no longer holds.** There is no hackathon ML report.
3. **`ImpactPort` stays `alwaysAbstain`.** Execution is the same whether or not a model is present. A missing, malformed or timed-out model does not change a hold.
4. **[0001](0001-open-team-decisions.md) #1 is moot for the hackathon.** No model clears a hold, soft or hard. `HoldReason` stays as it is.
5. **PR #102 is closed unmerged.** `main` does not gain the smoke-test code, logs, adapter hash or weights. The `ml/` tree on `main` stays as it was. No weights, tokens or caches are committed.

## Consequences

- The blocker board no longer has an ML chain. The issues are closed as not planned so they are not listed as ready work; the track file says they were deferred, not finished.
- After the hackathon the same issues can be reopened. No full-scope task waits on them.
