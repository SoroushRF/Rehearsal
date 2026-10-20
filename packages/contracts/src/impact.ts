import { z } from "zod";
import { Sha256Hex } from "./common";

/**
 * Advisory impact model contract. The response deliberately has no permission/execute flag:
 * advice can prioritize rechecks, never release a mandatory hold.
 */
export const ImpactRequest = z.object({
  planHash: Sha256Hex,
  stepId: z.string().min(1),
  step: z.record(z.string(), z.unknown()),
  change: z.object({
    entity: z.string().min(1),
    kind: z.string().min(1),
    before: z.unknown(),
    after: z.unknown(),
  }),
});
export type ImpactRequest = z.infer<typeof ImpactRequest>;

export const ImpactLabel = z.enum([
  "likely_unaffected",
  "arguments_changed",
  "step_dropped",
  "new_step_needed",
  "abstain",
]);
export type ImpactLabel = z.infer<typeof ImpactLabel>;

export const ImpactResponse = z.object({
  label: ImpactLabel,
  score: z.number().min(0).max(1).nullable(),
  modelRevision: z.string().min(1),
  evidenceRefs: z.array(z.string()),
});
export type ImpactResponse = z.infer<typeof ImpactResponse>;
