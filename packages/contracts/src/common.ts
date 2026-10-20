import { z } from "zod";

/** Version of the wire contracts. Bump on any breaking change; keep changes additive otherwise. */
export const CONTRACTS_VERSION = 1 as const;

export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "expected lowercase sha256 hex");
export type Sha256Hex = z.infer<typeof Sha256Hex>;

export const Timestamp = z.iso.datetime({ offset: true });

/** Start with one currency. Stripe uses lowercase ISO codes. */
export const Currency = z.enum(["cad"]);
export type Currency = z.infer<typeof Currency>;

/** Money is always integer minor units + currency. Never floating-point dollars. */
export const Money = z.object({
  amountMinor: z.int().nonnegative(),
  currency: Currency,
});
export type Money = z.infer<typeof Money>;

export const PositiveMoney = Money.extend({ amountMinor: z.int().positive() });

export const Vendor = z.enum(["stripe", "zendesk", "slack"]);
export type Vendor = z.infer<typeof Vendor>;

/** Which Era world a read/write happened in. The planner only ever sees "planning". */
export const World = z.enum(["planning", "operational"]);
export type World = z.infer<typeof World>;

export const EntityRef = z.object({
  vendor: Vendor,
  kind: z.string().min(1),
  id: z.string().min(1),
});
export type EntityRef = z.infer<typeof EntityRef>;

export const Role = z.enum(["support_lead", "finance_lead"]);
export type Role = z.infer<typeof Role>;

/**
 * Allowlisted result paths a later step may bind to. Fork-created IDs are never reused at
 * apply: the executor persists the actual operational result and resolves these refs from it.
 */
export const ResultPath = z.enum(["refund.id", "refund.status", "refund.amount"]);
export type ResultPath = z.infer<typeof ResultPath>;

export const ResultRef = z.object({
  $ref: z.literal("result"),
  stepId: z.string().min(1),
  path: ResultPath,
});
export type ResultRef = z.infer<typeof ResultRef>;

export const PolicyRef = z.object({
  id: z.string().min(1),
  version: z.int().positive(),
});
export type PolicyRef = z.infer<typeof PolicyRef>;
