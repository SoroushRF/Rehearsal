# 0001: Open team decisions (as of Oct 19)

Where the PDF brief and the build plan disagree. Settle these in the first team session, then record each answer here.

1. **Can the impact model clear a hold?** The brief's demo has rules hold ~60 steps and the model hold 4. The build plan makes the model advisory only, which removes that moment.
   - **Proposal:** split holds into hard and soft.
     - **Hard holds** (row changed, query membership changed, money or policy, approval invalid) are never model-overridable.
     - **Soft signals** (free-text ticket activity) are held by default. The model may clear one, with its reasoning logged on the receipt.
   - `HoldReason` in contracts v1 has only hard kinds. Add `soft_signal` once this is decided.
   - **Settled 2026-10-24 for the hackathon:** moot. No model clears a hold. `ImpactPort` stays `alwaysAbstain` ([0008](0008-ml-out-of-hackathon-scope.md)).
2. **Slack summary in the trimmed release?** The brief keeps one Slack post as the visible irreversible action; the plan cuts it.
   - **Proposal:** add `slack.message.postSummary` as the final step once the core passes. Never blindly retry an uncertain post.
   - **Settled 2026-10-24:** in, as proposed ([0009](0009-reopen-full-scope.md)).
3. **Closing line.** "Eon recovers it" implies a recovery feature we aren't building.
   - **Proposal:** "Rehearse the plan. Approve its effects. Apply with evidence."
4. **Pivot clause.** The brief says switch to Discharge Diff if the day-one Era gate fails; the plan says narrow scope and stay.
   - **Proposal:** stay on Rehearsal.
5. **Deploy target.** Render private services vs. one Compose VM.
   - **Proposal:** prove Render private networking with the first thin slice. Fall back to the VM if it fails.
