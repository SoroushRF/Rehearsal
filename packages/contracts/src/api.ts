import { z } from "zod";
import { Sha256Hex } from "./common";

/** Every command names the exact revision/hash it acts on; the server loads its own copy. */
export const CreateRevisionRequest = z.object({
  baseRevision: z.int().positive(),
  basePlanHash: Sha256Hex,
  excludeActionIds: z.array(z.string()).min(1),
});
export type CreateRevisionRequest = z.infer<typeof CreateRevisionRequest>;

export const ApproveRequest = z.object({
  revision: z.int().positive(),
  planHash: Sha256Hex,
});
export type ApproveRequest = z.infer<typeof ApproveRequest>;

export const ApplyRequest = ApproveRequest;
export type ApplyRequest = z.infer<typeof ApplyRequest>;

/**
 * T1.37: repair a held run of a stored revision (decision 0016). IDs and the base hash only: the
 * API reads the run's receipts itself, and the planner plans the open cases again.
 */
export const RepairRequest = z.object({
  runId: z.string().min(1),
  revision: z.int().positive(),
  planHash: Sha256Hex,
});
export type RepairRequest = z.infer<typeof RepairRequest>;

export const HealthResponse = z.object({
  ok: z.literal(true),
  mode: z.enum(["core", "full"]),
  contractsVersion: z.int(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
