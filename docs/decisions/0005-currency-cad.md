# 0005: The demo currency is CAD (T2.9)

**Status:** accepted 2026-10-22 (Parsa, T2). Please raise objections in team chat or a PR.

## Context

#32 found that Era's own seed charges are USD (`scenarios/billing/fixtures/stripe.charge.json` is a verbatim USD charge), while `policy.v1.json` allows only CAD and `Currency` in the contracts is `cad` only. Policy rule R1 would have held every planned refund. Since then T1.2 has seeded the INC-BILL-0927 cohort itself (`scenarios/billing/incident.v1.json`, injected identically into both worlds).

## Decision

1. **CAD stays.** The policy, the contracts and the seeded cohort all use CAD. Nothing is converted.
2. Era's pre-existing USD charges are not part of the incident: the planner works from the seeded cohort, so they are never planned.
3. The cohort keeps exactly one USD duplicate (`control_other_currency`) as a control that the CAD-only policy must hold.
4. `packages/core/test/policy.test.ts` pins this: policy v1 is CAD, every seeded case except that control is CAD, and duplicates sit on both sides of the finance threshold (10000 minor units).

## Consequences

- Nothing in `policy.v1.json`, the contracts or the fixtures changes.
- Adding USD later means an additive `Currency` change in the contracts (reviewed by another track) and a policy v2, never a silent edit of v1.
- On stage, say plainly that amounts are CAD in a simulated Stripe.
