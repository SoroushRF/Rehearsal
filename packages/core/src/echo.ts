import type { AuthzDecision, AuthzRequest } from "@rehearsal/contracts";

/**
 * True when the decision is about the action and the facts we sent, including nested keys.
 * The same check the API uses before it trusts an IAM answer.
 */
export function decisionEchoes(request: AuthzRequest, decision: AuthzDecision): boolean {
  return (
    decision.action === request.action &&
    decision.rule.id === request.rule.id &&
    decision.rule.version === request.rule.version &&
    canonicalResource(decision.resource) === canonicalResource(request.resource)
  );
}

function canonicalResource(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalResource).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonicalResource(inner)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
