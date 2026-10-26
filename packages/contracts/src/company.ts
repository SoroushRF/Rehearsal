import { z } from "zod";
import { Currency, Timestamp } from "./common";

/**
 * `GET /api/company`: the signed-in org's operational world, read by the server. Read-only; the
 * browser never sends any of this back.
 */
export const CompanyCharge = z.object({
  id: z.string().min(1),
  customer: z.string().min(1),
  invoice: z.string().nullable(),
  amountMinor: z.int().nonnegative(),
  currency: Currency,
  created: Timestamp,
  refundedMinor: z.int().nonnegative(),
});
export type CompanyCharge = z.infer<typeof CompanyCharge>;

export const CompanyCustomer = z.object({
  id: z.string().min(1),
  email: z.string().nullable(),
  /** Stripe customer balance in minor units; negative is credit owed to the customer. */
  balanceMinor: z.int(),
});
export type CompanyCustomer = z.infer<typeof CompanyCustomer>;

export const CompanyTicket = z.object({
  id: z.int().positive(),
  subject: z.string(),
  status: z.string(),
  priority: z.string().nullable(),
  requester: z.string(),
  updatedAt: Timestamp,
});
export type CompanyTicket = z.infer<typeof CompanyTicket>;

export const CompanySlackMessage = z.object({
  ts: z.string().min(1),
  channel: z.string().min(1),
  text: z.string(),
});
export type CompanySlackMessage = z.infer<typeof CompanySlackMessage>;

export const CompanySnapshot = z.object({
  asOf: Timestamp,
  charges: z.array(CompanyCharge),
  customers: z.array(CompanyCustomer),
  tickets: z.array(CompanyTicket),
  slack: z.array(CompanySlackMessage),
  /** Record ID (charge, customer, ticket ID as a string, or Slack ts) → the run whose receipt changed it. */
  changed: z.record(z.string(), z.string()),
});
export type CompanySnapshot = z.infer<typeof CompanySnapshot>;
