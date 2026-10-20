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

export const HealthResponse = z.object({
  ok: z.literal(true),
  mode: z.enum(["core", "full"]),
  contractsVersion: z.int(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
