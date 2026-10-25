import { z } from "zod";

/** Why a plan's precedents no longer hold, as the API reports it (`checkPrecedentBasis`). */
export const PrecedentHold = z.union([
  z.object({
    id: z.string(),
    reason: z.enum(["withdrawn", "superseded", "not_active", "content_changed"]),
    citedVersion: z.int(),
    activeVersion: z.int().nullable(),
  }),
  z.object({
    appliesTo: z.string(),
    reason: z.literal("epoch_changed"),
    plannedEpoch: z.int(),
    currentEpoch: z.int(),
  }),
]);
export type PrecedentHold = z.infer<typeof PrecedentHold>;

export const PrecedentCheck = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), holds: z.array(PrecedentHold) }),
]);
export type PrecedentCheck = z.infer<typeof PrecedentCheck>;

/** One sentence per hold, with no registry jargon. */
export function explainPrecedentHold(h: PrecedentHold): string {
  if ("appliesTo" in h) {
    return `Something in ${h.appliesTo} changed since this plan was made (precedent set ${h.plannedEpoch}, now ${h.currentEpoch}), including precedents the planner may never have seen.`;
  }
  switch (h.reason) {
    case "withdrawn":
      return `${h.id} v${h.citedVersion} was withdrawn, so nothing is in force in its place.`;
    case "superseded":
      return `${h.id} v${h.citedVersion} was replaced by v${h.activeVersion}.`;
    case "not_active":
      return `${h.id} v${h.citedVersion} isn't the version in force (v${h.activeVersion} is).`;
    case "content_changed":
      return `${h.id} v${h.citedVersion} no longer says what it said when the plan was made.`;
  }
}
