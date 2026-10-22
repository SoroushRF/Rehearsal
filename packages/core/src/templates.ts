/**
 * Private-note templates. Notes are rendered only from an approved template plus literals and
 * bindings to confirmed receipts, never from model text. Each note carries an operation marker so
 * reconciliation can find it by reading the ticket's comments.
 */
const TEMPLATES: Record<string, (v: Readonly<Record<string, string | number>>) => string> = {
  "refund-confirmed@1": (v) =>
    `Refund ${v.refundId} for ${formatCad(Number(v.amountMinor))} has been issued for the duplicate charge.`,
};

function formatCad(minor: number): string {
  if (!Number.isInteger(minor)) throw new TypeError(`amountMinor must be an integer, got ${minor}`);
  return `${(minor / 100).toFixed(2)} CAD`;
}

export function operationMarker(operationKey: string): string {
  return `[rehearsal-op:${operationKey}]`;
}

export function renderNote(
  template: { id: string; version: number },
  values: Readonly<Record<string, string | number>>,
  operationKey: string,
): string {
  const render = TEMPLATES[`${template.id}@${template.version}`];
  if (!render) throw new Error(`unknown note template ${template.id}@${template.version}`);
  return `${render(values)}\n\n${operationMarker(operationKey)}`;
}
