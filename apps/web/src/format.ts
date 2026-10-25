import type { CompensationClass, Money, ProtectionLevel, Role } from "@rehearsal/contracts";

/**
 * Formats integer minor units without going through a float: Intl parses decimal strings
 * exactly, so 4210 CAD becomes "$42.10 CAD" with no rounding.
 */
export function formatMoney({ amountMinor, currency }: Money): string {
  const code = currency.toUpperCase();
  const nf = new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: code,
    currencyDisplay: "narrowSymbol",
  });
  const digits = nf.resolvedOptions().maximumFractionDigits ?? 2;
  const raw = String(amountMinor).padStart(digits + 1, "0");
  const decimal = digits === 0 ? raw : `${raw.slice(0, -digits)}.${raw.slice(-digits)}`;
  return `${nf.format(decimal as Intl.StringNumericLiteral)} ${code}`;
}

/** Sums refunds per currency. Mixed currencies are never added together. */
export function sumMoney(amounts: readonly Money[]): Money[] {
  const totals = new Map<Money["currency"], number>();
  for (const m of amounts) totals.set(m.currency, (totals.get(m.currency) ?? 0) + m.amountMinor);
  return [...totals].map(([currency, amountMinor]) => ({ currency, amountMinor }));
}

export const shortHash = (hash: string) => `${hash.slice(0, 12)}…`;

export const roleLabel: Record<Role, string> = {
  support_lead: "Support lead",
  finance_lead: "Finance lead",
};

export const compensationLabel: Record<CompensationClass, { text: string; hint: string }> = {
  conditional_reversible: {
    text: "Reversible if unchanged",
    hint: "Undo only restores a field that still holds the value we wrote.",
  },
  compensable_by_new_action: {
    text: "Compensable",
    hint: "Can't be erased; a new, separately approved action may offset it.",
  },
  irreversible: { text: "Irreversible", hint: "Appended or sent; stays forever." },
};

export const protectionLabel: Record<ProtectionLevel, { text: string; hint: string }> = {
  native_guard_with_documented_limits: {
    text: "Native guard",
    hint: "The provider rejects the write if the record changed, within its documented limits.",
  },
  best_effort_reread: {
    text: "Best-effort re-read",
    hint: "Re-read right before the write; a change in between can slip through.",
  },
  no_atomic_guard: {
    text: "No atomic guard",
    hint: "The provider offers no conditional write for this operation.",
  },
};

/** "happy-path" → "Happy path": ids made readable for labels. */
export const humanize = (id: string) =>
  (id[0]?.toUpperCase() ?? "") + id.slice(1).replaceAll("-", " ");
