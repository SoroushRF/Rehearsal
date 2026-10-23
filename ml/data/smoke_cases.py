"""Synthetic impact cases for the T4.5 smoke test.

Each case is shaped like an `ImpactRequest` (packages/contracts/src/impact.ts) from the
INC-BILL-0927 billing scenario: one planned step plus one change seen after approval, labelled
with an `ImpactLabel`. The labels are hand rules, good enough to exercise a training step.
They are not the T4.6 labels and say nothing about model quality.
"""

import hashlib
import json
import random

LABELS = ("likely_unaffected", "arguments_changed", "step_dropped", "new_step_needed")


def _refund_step(i: int, amount: int) -> dict:
    return {
        "op": "stripe.refund.create",
        "args": {"charge": f"ch_smoke_{i:03d}", "amount": {"minor": amount, "currency": "CAD"}},
    }


def _ticket_step(i: int) -> dict:
    return {"op": "zendesk.ticket.patchFields", "args": {"ticket": str(9100000 + i), "fields": {"priority": "high"}}}


def _case(i: int, rng: random.Random) -> dict:
    amount = rng.choice([4210, 8900, 12500, 15000])
    label = LABELS[i % len(LABELS)]
    if label == "likely_unaffected":
        step = _refund_step(i, amount)
        change = {"entity": f"stripe:charge:ch_smoke_{i:03d}", "kind": "metadata", "before": {"note": None}, "after": {"note": "viewed"}}
    elif label == "arguments_changed":
        step = _refund_step(i, amount)
        partial = rng.choice([1000, 2000])
        change = {
            "entity": f"stripe:charge:ch_smoke_{i:03d}",
            "kind": "amount_refunded",
            "before": {"amount_refunded": 0},
            "after": {"amount_refunded": partial},
        }
    elif label == "step_dropped":
        if rng.random() < 0.5:
            step = _refund_step(i, amount)
            change = {
                "entity": f"stripe:charge:ch_smoke_{i:03d}",
                "kind": "refunded",
                "before": {"refunded": False},
                "after": {"refunded": True},
            }
        else:
            step = _ticket_step(i)
            change = {"entity": f"zendesk:ticket:{9100000 + i}", "kind": "status", "before": {"status": "open"}, "after": {"status": "closed"}}
    else:
        step = _refund_step(i, amount)
        change = {
            "entity": f"stripe:customer:cus_smoke_{i:03d}",
            "kind": "query_membership",
            "before": {"charges": [f"ch_smoke_{i:03d}"]},
            "after": {"charges": [f"ch_smoke_{i:03d}", f"ch_smoke_{i:03d}_phantom"]},
        }
    return {"id": f"smoke_{i:03d}", "stepId": f"step_{i:03d}", "step": step, "change": change, "label": label}


def smoke_cases(n: int = 32, seed: int = 0) -> list[dict]:
    rng = random.Random(seed)
    return [_case(i, rng) for i in range(n)]


def cases_sha256(cases: list[dict]) -> str:
    blob = "\n".join(json.dumps(c, sort_keys=True, separators=(",", ":")) for c in cases)
    return hashlib.sha256(blob.encode()).hexdigest()


if __name__ == "__main__":
    cases = smoke_cases()
    print(json.dumps({"count": len(cases), "sha256": cases_sha256(cases)}))
