import { z } from "zod";
import { CONTRACTS_VERSION, Vendor, World } from "./common";
import { ReceiptOutcome } from "./execution";
import { PlanManifest } from "./plan";

/** A change applied to a world between approval and/or during apply. */
export const Perturbation = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("inject_records"),
    vendor: Vendor,
    world: World,
    /** Body for /_admin/tenants/{T}/inject, in the simulator's own data format. */
    records: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
    /** When to apply: before apply starts, or right before a given step is admitted. */
    at: z.union([z.literal("before_apply"), z.object({ beforeStep: z.string() })]),
  }),
  z.object({
    kind: z.literal("teammate_field_edit"),
    ticketId: z.string(),
    field: z.enum(["priority", "status"]),
    value: z.string(),
    at: z.object({ afterStep: z.string() }),
  }),
  z.object({
    kind: z.literal("fault"),
    vendor: Vendor,
    /** Era /_admin/faults config; container-wide, so serialize fault tests. */
    config: z.record(z.string(), z.unknown()),
  }),
  z.object({
    /** Rehearsal test transport: forward the mutation, then drop the response. Not an Era feature. */
    kind: z.literal("drop_response_after_commit"),
    stepId: z.string(),
  }),
  z.object({
    kind: z.literal("fail_step"),
    stepId: z.string(),
  }),
]);
export type Perturbation = z.infer<typeof Perturbation>;

export const ReplayBundle = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  id: z.string().min(1),
  title: z.string().min(1),
  /** "fixture" until the bundle has been run against real Era images. */
  evidence: z.enum(["fixture", "era_integration"]),
  manifest: PlanManifest,
  perturbations: z.array(Perturbation),
  /** Independent expected outcomes per action (owned by evaluation, not the executor). */
  expected: z.array(z.object({ actionId: z.string(), outcome: ReceiptOutcome })),
});
export type ReplayBundle = z.infer<typeof ReplayBundle>;
