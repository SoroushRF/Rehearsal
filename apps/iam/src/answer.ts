import { decide } from "@rehearsal/authz";
import { type AuthzDecision, AuthzRequest, type AuthzRuleFile } from "@rehearsal/contracts";
import type { ClerkVerifier } from "./clerk";
import { ruleKey } from "./rules";

export interface AnswerLog {
  action: string;
  subject: { userId: string; orgId: string } | null;
  ruleId: string;
  ruleVersion: number;
  matchedRule: number | null;
  effect: "allow" | "deny";
  reason: string;
}

export interface Answer {
  decision: AuthzDecision;
  log: AnswerLog;
}

const UNKNOWN_RULE = { id: "unknown", version: 1 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Enough of a broken request to echo back. A deny still has to name an action and a rule. */
function echo(raw: unknown): Pick<AuthzDecision, "action" | "rule" | "resource"> {
  const body = isRecord(raw) ? raw : {};
  const action =
    typeof body.action === "string" && body.action.length > 0 ? body.action : "unknown";
  const rule = isRecord(body.rule) ? body.rule : {};
  const id = typeof rule.id === "string" && rule.id.length > 0 ? rule.id : UNKNOWN_RULE.id;
  const version =
    typeof rule.version === "number" && Number.isInteger(rule.version) && rule.version > 0
      ? rule.version
      : UNKNOWN_RULE.version;
  const resource = isRecord(body.resource) ? body.resource : {};
  return { action, rule: { id, version }, resource };
}

function denied(
  echoed: Pick<AuthzDecision, "action" | "rule" | "resource">,
  reason: string,
  subject: AnswerLog["subject"] = null,
): Answer {
  const decision: AuthzDecision = { effect: "deny", ...echoed, reason };
  return {
    decision,
    log: {
      action: decision.action,
      subject,
      ruleId: decision.rule.id,
      ruleVersion: decision.rule.version,
      matchedRule: null,
      effect: "deny",
      reason,
    },
  };
}

/**
 * One question. Person mode verifies the bearer token here; grants mode (`run:admit`) does not
 * call Clerk. Anything this cannot trust is a deny, and the reason says which.
 */
export async function answerRequest(
  raw: unknown,
  deps: { files: ReadonlyMap<string, AuthzRuleFile>; clerk: ClerkVerifier; now: Date },
): Promise<Answer> {
  try {
    const parsed = AuthzRequest.safeParse(raw);
    if (!parsed.success) return denied(echo(raw), "bad request");
    const request = parsed.data;
    const echoed = { action: request.action, rule: request.rule, resource: request.resource };
    const file = deps.files.get(ruleKey(request.rule.id, request.rule.version));
    if (!file)
      return denied(echoed, `unknown rule ${ruleKey(request.rule.id, request.rule.version)}`);

    let subject: { userId: string; orgId: string; clerkRole: string | null } | null = null;
    if (request.mode.kind === "person") {
      const person = await deps.clerk.verify(request.mode.token);
      if (!person) return denied(echoed, "unauthenticated");
      if (!person.orgId) return denied(echoed, "no active organization");
      subject = { userId: person.userId, orgId: person.orgId, clerkRole: person.orgRole };
    }

    const result = decide({
      file,
      action: request.action,
      subject,
      resource: request.resource,
      now: deps.now,
    });
    const decision: AuthzDecision = { ...echoed, effect: result.effect, reason: result.reason };
    return {
      decision,
      log: {
        action: decision.action,
        subject: subject && { userId: subject.userId, orgId: subject.orgId },
        ruleId: request.rule.id,
        ruleVersion: request.rule.version,
        matchedRule: result.ruleIndex,
        effect: result.effect,
        reason: result.reason,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return denied(echo(raw), `error: ${message}`);
  }
}
