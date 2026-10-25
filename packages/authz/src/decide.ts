import type { AuthzCheck, AuthzRule, AuthzRuleFile, PermissionV1 } from "@rehearsal/contracts";

/**
 * The policy decision point (decision 0014). Pure: the rule file, the facts and the clock are all
 * passed in. It knows paths, comparisons and permissions, not what a plan or a refund is.
 * Anything it cannot read with certainty is a deny.
 */

export interface AuthzSubject {
  userId: string;
  orgId: string;
  clerkRole: string | null;
}

export interface DecideInput {
  file: AuthzRuleFile;
  action: string;
  /** `null` is grants mode (`run:admit`): no person is asking. */
  subject: AuthzSubject | null;
  resource: Record<string, unknown>;
  now: Date;
}

export interface Decision {
  effect: "allow" | "deny";
  reason: string;
  ruleIndex: number | null;
}

const MAX_DEPTH = 16;
const NUMBER = /^-?\d+(\.\d+)?$/;
const PATH_ROOTS = ["subject", "resource", "item", "env"] as const;

type Root = (typeof PATH_ROOTS)[number];
type Scope = Partial<Record<Root, unknown>>;
type Primitive = string | number | boolean | null;

/** Clerk role → our role → permissions. An unmapped or missing Clerk role has none. */
export function permissionsFor(file: AuthzRuleFile, clerkRole: string | null): PermissionV1[] {
  if (clerkRole === null || !Object.hasOwn(file.rolesFromClerk, clerkRole)) return [];
  const orgRole = file.rolesFromClerk[clerkRole];
  if (orgRole === undefined || !Object.hasOwn(file.roles, orgRole)) return [];
  return [...file.roles[orgRole]];
}

export function decide(input: DecideInput): Decision {
  try {
    return decideUnsafe(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { effect: "deny", reason: `error: ${message}`, ruleIndex: null };
  }
}

function decideUnsafe({ file, action, subject, resource, now }: DecideInput): Decision {
  const candidates = file.rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => rule.action === action);
  if (candidates.length === 0) {
    return { effect: "deny", reason: `no rule for ${action}`, ruleIndex: null };
  }

  const scope: Scope = {
    subject:
      subject === null
        ? undefined
        : {
            userId: subject.userId,
            orgId: subject.orgId,
            permissions: permissionsFor(file, subject.clerkRole),
          },
    resource,
    env: { now: now.toISOString() },
  };

  // A rule whose facts matched but whose permissions did not explains the deny better than an
  // alternative whose facts never applied (the two-person rule when `dualRequired` is false).
  let lastFailure = "";
  let lastApplicableFailure: string | null = null;
  for (const { rule, index } of candidates) {
    const rbacFailure = checkRbac(rule, subject !== null, scope);
    const abacFailure = checkAbac(rule, scope);
    if (rbacFailure === null && abacFailure === null) {
      return { effect: "allow", reason: `rule ${index} allows ${action}`, ruleIndex: index };
    }
    lastFailure = `rule ${index}: ${rbacFailure ?? abacFailure}`;
    if (abacFailure === null) lastApplicableFailure = lastFailure;
  }
  return { effect: "deny", reason: lastApplicableFailure ?? lastFailure, ruleIndex: null };
}

/** `null` when every `abac` check passes, otherwise the first that failed. */
function checkAbac(rule: AuthzRule, scope: Scope): string | null {
  for (const check of rule.abac) {
    const reason = evaluate(check, scope, 0);
    if (reason !== null) return reason;
  }
  return null;
}

function checkRbac(rule: AuthzRule, hasSubject: boolean, scope: Scope): string | null {
  const rbac: Record<string, unknown> = rule.rbac;
  const personRule = "anyOf" in rbac || "allOf" in rbac;
  if (!personRule) {
    return hasSubject ? "rule takes no subject, but one was given" : null;
  }
  if (!hasSubject) return "rule needs a subject, but none was given";

  const held = stringArray(resolve("subject.permissions", scope));
  if (held === null) return "subject permissions unreadable";

  if ("anyOf" in rbac) {
    const anyOf = stringArray(rbac.anyOf);
    if (anyOf === null || anyOf.length === 0) return "rbac.anyOf malformed";
    if (anyOf.some((permission) => held.includes(permission))) return null;
    return `subject lacks ${anyOf.join(" or ")}`;
  }

  if (typeof rbac.allOf !== "string") return "rbac.allOf malformed";
  const required = stringArray(resolve(rbac.allOf, scope));
  if (required === null) return `${rbac.allOf} is not a list of permissions`;
  if (required.length === 0) return `${rbac.allOf} is empty`;
  const missing = required.find((permission) => !held.includes(permission));
  return missing === undefined ? null : `subject lacks ${missing}`;
}

function evaluate(check: AuthzCheck, scope: Scope, depth: number): string | null {
  if (depth > MAX_DEPTH) return "checks nested too deeply";
  const c: Record<string, unknown> = check;

  if ("eq" in check) {
    const [a, b] = check.eq;
    const left = primitive(resolve(a, scope));
    const right = primitive(resolve(b, scope));
    if (left === undefined || right === undefined || left !== right) return `${a} != ${b}`;
    return null;
  }

  if ("gt" in check) {
    const [a, b] = check.gt;
    const left = resolve(a, scope);
    const right = resolve(b, scope);
    if (typeof left === "number" && typeof right === "number") {
      if (Number.isFinite(left) && Number.isFinite(right) && left > right) return null;
      return `${a} not > ${b}`;
    }
    if (typeof left === "string" && typeof right === "string") {
      const l = Date.parse(left);
      const r = Date.parse(right);
      if (!Number.isNaN(l) && !Number.isNaN(r) && l > r) return null;
    }
    return `${a} not > ${b}`;
  }

  if ("isNull" in check) {
    return resolve(check.isNull, scope) === null ? null : `${check.isNull} is not null`;
  }

  if ("allOf" in check) {
    const [a, b] = check.allOf;
    const held = stringArray(resolve(a, scope));
    const required = stringArray(resolve(b, scope));
    if (held === null || required === null || required.length === 0) {
      return `${a} does not cover ${b}`;
    }
    const missing = required.find((value) => !held.includes(value));
    return missing === undefined ? null : `${a} lacks ${missing}`;
  }

  if ("some" in check) {
    const { in: path, where } = check.some;
    const items = resolve(path, scope);
    if (!Array.isArray(items)) return `${path} is not a list`;
    const passes = items.some((item) => allPass(where, { ...scope, item }, depth + 1));
    return passes ? null : `no item in ${path} passes`;
  }

  if ("seats" in check) {
    const { in: path, where, fill, distinct } = check.seats;
    const items = resolve(path, scope);
    if (!Array.isArray(items)) return `${path} is not a list`;
    const candidates: { permissions: string[]; key: string }[] = [];
    for (const item of items) {
      const itemScope = { ...scope, item };
      if (!allPass(where, itemScope, depth + 1)) continue;
      const permissions = stringArray(resolve("item.permissions", itemScope));
      const key = resolve(distinctPath(distinct), itemScope);
      if (permissions === null || typeof key !== "string") continue;
      candidates.push({ permissions, key });
    }
    if (assignSeats(fill, candidates, 0, new Set())) return null;
    return `${path} cannot fill ${fill.join(", ")} with different ${distinct}`;
  }

  return `unknown check ${Object.keys(c).join(",") || "{}"}`;
}

function allPass(checks: AuthzCheck[], scope: Scope, depth: number): boolean {
  return checks.every((check) => evaluate(check, scope, depth) === null);
}

/** Backtracking: every seat gets a candidate holding its permission, no `distinct` value twice. */
function assignSeats(
  seats: readonly string[],
  candidates: readonly { permissions: string[]; key: string }[],
  seat: number,
  usedKeys: Set<string>,
): boolean {
  const permission = seats[seat];
  if (permission === undefined) return true;
  for (const candidate of candidates) {
    if (usedKeys.has(candidate.key) || !candidate.permissions.includes(permission)) continue;
    usedKeys.add(candidate.key);
    if (assignSeats(seats, candidates, seat + 1, usedKeys)) return true;
    usedKeys.delete(candidate.key);
  }
  return false;
}

/** `distinct` names a field on each item (`actorUserId`), or is a full path (`item.actorUserId`). */
function distinctPath(distinct: string): string {
  return isPath(distinct) ? distinct : `item.${distinct}`;
}

function isPath(operand: string): boolean {
  return PATH_ROOTS.some((root) => operand.startsWith(`${root}.`));
}

/** A path walks own properties from its root; anything else is a literal. Missing → `undefined`. */
function resolve(operand: string, scope: Scope): unknown {
  if (!isPath(operand)) return literal(operand);
  const [root, ...keys] = operand.split(".");
  let current: unknown = scope[root as Root];
  for (const key of keys) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, key)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function literal(operand: string): Primitive {
  if (operand === "true") return true;
  if (operand === "false") return false;
  if (operand === "null") return null;
  if (NUMBER.test(operand)) return Number(operand);
  return operand;
}

function primitive(value: unknown): Primitive | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return value;
  return undefined;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((entry) => typeof entry === "string") ? value : null;
}
