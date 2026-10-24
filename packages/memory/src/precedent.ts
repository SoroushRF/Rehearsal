import type { Sha256Hex } from "@rehearsal/contracts";
import { canonicalize, fingerprint } from "@rehearsal/core";
import { z } from "zod";

/** A stable lowercase slug. The memory entity is named `precedent:<id>`. */
export const PrecedentId = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "precedent id must be a lowercase slug");

const NonBlank = z.string().refine((s) => s.trim().length > 0, "must not be blank");

/**
 * A finance-approved precedent, exactly as promoted. Postgres holds the approved version; Agent
 * Memory holds a copy for recall, and readback checks the copy against this. Strict, so a stored
 * copy carrying fields we never wrote fails readback instead of being silently trimmed.
 */
export const PrecedentRecord = z
  .strictObject({
    id: PrecedentId,
    version: z.int().positive(),
    /** The cases it covers, e.g. `billing.duplicate_charge`. Changes here bump the area's epoch. */
    appliesTo: z
      .string()
      .regex(/^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/, "appliesTo must be dotted lowercase"),
    statement: NonBlank,
    conditions: z.array(NonBlank),
    exceptions: z.array(NonBlank),
    effectiveFrom: z.iso.date(),
    /** Exclusive. Null while it still holds. */
    effectiveUntil: z.iso.date().nullable(),
    /** Promotion is finance-authorized; nobody else can author a precedent. */
    author: z.strictObject({ userId: z.string().min(1), role: z.literal("finance_lead") }),
    approvedAt: z.iso.datetime({ offset: true }),
  })
  .refine((r) => r.effectiveUntil === null || r.effectiveUntil > r.effectiveFrom, {
    message: "effectiveUntil must be after effectiveFrom",
    path: ["effectiveUntil"],
  });
export type PrecedentRecord = z.infer<typeof PrecedentRecord>;

/** Hash of the validated record: what a citation binds to, beside the version. */
export function precedentDigest(record: PrecedentRecord): Sha256Hex {
  return fingerprint(PrecedentRecord.parse(record));
}

/** Whether the precedent holds on `day` (YYYY-MM-DD, UTC). */
export function isEffective(record: PrecedentRecord, day: string): boolean {
  return (
    record.effectiveFrom <= day && (record.effectiveUntil === null || day < record.effectiveUntil)
  );
}

export const ENTITY_TYPE = "concept";
const NAME_PREFIX = "precedent:";

export function entityName(id: string): string {
  return `${NAME_PREFIX}${PrecedentId.parse(id)}`;
}

/** The precedent ID an entity name stands for, or null for any other entity. */
export function precedentIdOf(name: string): string | null {
  if (!name.startsWith(NAME_PREFIX)) return null;
  const id = name.slice(NAME_PREFIX.length);
  return PrecedentId.safeParse(id).success ? id : null;
}

/**
 * The three attributes a precedent is stored as. `record` is the canonical JSON and the only one
 * readback trusts; `statement` and `version` are there so recall has plain text to match, and
 * must agree with it. Every publish writes all three, so no key keeps a value from an older
 * version.
 */
export const ATTRIBUTE_KEYS = ["statement", "version", "record"] as const;

export interface Triple {
  entity: { type: string; name: string };
  key: string;
  value: string;
}

export function toTriples(record: PrecedentRecord): Triple[] {
  const parsed = PrecedentRecord.parse(record);
  const entity = { type: ENTITY_TYPE, name: entityName(parsed.id) };
  return [
    { entity, key: "statement", value: parsed.statement },
    { entity, key: "version", value: String(parsed.version) },
    { entity, key: "record", value: canonicalize(parsed) },
  ];
}

/** A live attribute as Agent Memory returns it, narrowed to what readback looks at. */
export interface StoredAttribute {
  id: string;
  key: string;
  value: unknown;
  memoryCategory: string;
  scope: string[][];
}

export type Decoded =
  | { ok: true; record: PrecedentRecord; digest: Sha256Hex; factIds: string[] }
  | { ok: false; reason: string };

/** Scope paths come back with a trailing slash; we compare without it. */
export function normalizeScope(path: string): string {
  return path.replace(/\/+$/, "");
}

/** Tagged with exactly this one scope: not a parent, a child, a sibling, or a conjunction. */
export function inExactScope(attribute: StoredAttribute, scope: string): boolean {
  const [clause, ...rest] = attribute.scope;
  return (
    rest.length === 0 &&
    clause?.length === 1 &&
    normalizeScope(clause[0] ?? "") === normalizeScope(scope)
  );
}

/**
 * Rebuild a precedent from an entity's live attributes. Only attributes in exactly `scope` count:
 * attributes are kept per scope, so anyone who can write a neighbouring scope can add a live
 * `statement` to the same entity, and a wide reader sees both. Anything short of exactly our
 * three keys, agreeing with each other and with the canonical record, fails.
 */
export function decodeAttributes(
  id: string,
  scope: string,
  attributes: StoredAttribute[],
): Decoded {
  const ours = attributes.filter((a) => inExactScope(a, scope));
  const byKey = new Map<string, StoredAttribute[]>();
  for (const a of ours) byKey.set(a.key, [...(byKey.get(a.key) ?? []), a]);

  for (const key of byKey.keys()) {
    if (!(ATTRIBUTE_KEYS as readonly string[]).includes(key)) {
      return { ok: false, reason: `unexpected attribute "${key}"` };
    }
  }
  const values: Partial<Record<(typeof ATTRIBUTE_KEYS)[number], StoredAttribute>> = {};
  for (const key of ATTRIBUTE_KEYS) {
    const found = byKey.get(key) ?? [];
    if (found.length === 0) return { ok: false, reason: `missing attribute "${key}"` };
    if (found.length > 1) return { ok: false, reason: `conflicting values for "${key}"` };
    const [only] = found;
    if (only === undefined || typeof only.value !== "string") {
      return { ok: false, reason: `attribute "${key}" is not a string` };
    }
    if (only.memoryCategory !== "knowledge") {
      return { ok: false, reason: `attribute "${key}" is stored as ${only.memoryCategory}` };
    }
    values[key] = only;
  }
  const {
    statement,
    version,
    record: raw,
  } = values as Record<(typeof ATTRIBUTE_KEYS)[number], StoredAttribute & { value: string }>;

  let json: unknown;
  try {
    json = JSON.parse(raw.value);
  } catch {
    return { ok: false, reason: "record is not JSON" };
  }
  const parsed = PrecedentRecord.safeParse(json);
  if (!parsed.success) return { ok: false, reason: `record is invalid: ${parsed.error.message}` };
  const record = parsed.data;
  if (canonicalize(record) !== raw.value) return { ok: false, reason: "record is not canonical" };
  if (record.id !== id) return { ok: false, reason: `record is for "${record.id}"` };
  if (statement.value !== record.statement) {
    return { ok: false, reason: "statement disagrees with record" };
  }
  if (version.value !== String(record.version)) {
    return { ok: false, reason: "version disagrees with record" };
  }
  return {
    ok: true,
    record,
    digest: precedentDigest(record),
    factIds: [statement.id, version.id, raw.id].sort(),
  };
}
