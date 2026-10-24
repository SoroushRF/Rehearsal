import { canonicalize } from "@rehearsal/core";
import { describe, expect, it } from "vitest";
import {
  decodeAttributes,
  entityName,
  isEffective,
  PrecedentRecord,
  precedentDigest,
  precedentIdOf,
  type StoredAttribute,
  toTriples,
} from "../src/precedent";
import { precedent, SCOPE } from "./fixtures";

const stored = (record = precedent(), scope = `${SCOPE}/`): StoredAttribute[] =>
  toTriples(record).map((t, i) => ({
    id: `a${i}`,
    key: t.key,
    value: t.value,
    memoryCategory: "knowledge",
    scope: [[scope]],
  }));

const replace = (key: string, patch: Partial<StoredAttribute>) => (a: StoredAttribute[]) =>
  a.map((x) => (x.key === key ? { ...x, ...patch } : x));

describe("PrecedentRecord", () => {
  it("parses a finance-approved precedent", () => {
    expect(PrecedentRecord.parse(precedent())).toEqual(precedent());
  });

  it("only finance can author one", () => {
    const author = { userId: "u", role: "support_lead" } as never;
    expect(PrecedentRecord.safeParse(precedent({ author })).success).toBe(false);
  });

  it("refuses fields it doesn't know, so readback can't trim a tampered copy", () => {
    expect(PrecedentRecord.safeParse({ ...precedent(), maxAmount: 1 }).success).toBe(false);
    const author = { userId: "u", role: "finance_lead", name: "x" } as never;
    expect(PrecedentRecord.safeParse(precedent({ author })).success).toBe(false);
  });

  it("needs a slug id, real dates, an end after the start and non-blank text", () => {
    const bad: Partial<PrecedentRecord>[] = [
      { id: "Duplicate Charge" },
      { id: "a/b" },
      { version: 0 },
      { version: 1.5 },
      { appliesTo: "Billing" },
      { statement: "  " },
      { conditions: [""] },
      { effectiveFrom: "2026-13-01" },
      { effectiveUntil: "2026-10-01" },
      { effectiveUntil: "2026-09-30" },
      { approvedAt: "yesterday" },
    ];
    for (const overrides of bad) {
      const result = PrecedentRecord.safeParse(precedent(overrides));
      expect(result.success, JSON.stringify(overrides)).toBe(false);
    }
  });

  it("is effective from its start up to, not including, its end", () => {
    const r = precedent({ effectiveUntil: "2026-11-01" });
    expect(isEffective(r, "2026-09-30")).toBe(false);
    expect(isEffective(r, "2026-10-01")).toBe(true);
    expect(isEffective(r, "2026-10-31")).toBe(true);
    expect(isEffective(r, "2026-11-01")).toBe(false);
    expect(isEffective(precedent(), "2099-01-01")).toBe(true);
  });

  it("digests the content, so any change gives a new digest", () => {
    expect(precedentDigest(precedent())).toBe(precedentDigest(precedent()));
    expect(precedentDigest(precedent())).toMatch(/^[0-9a-f]{64}$/);
    expect(precedentDigest(precedent({ exceptions: [] }))).not.toBe(precedentDigest(precedent()));
  });
});

describe("entity names", () => {
  it("names the entity precedent:<id> and reads the id back", () => {
    expect(entityName("duplicate-charge-refund")).toBe("precedent:duplicate-charge-refund");
    expect(precedentIdOf("precedent:duplicate-charge-refund")).toBe("duplicate-charge-refund");
  });

  it("never builds a name with a slash, which the service can't read back", () => {
    expect(() => entityName("a/b")).toThrow();
  });

  it("ignores entities that aren't precedents", () => {
    expect(precedentIdOf("Ana Silva")).toBeNull();
    expect(precedentIdOf("precedent:Bad Name")).toBeNull();
    expect(precedentIdOf("precedent:")).toBeNull();
  });
});

describe("toTriples", () => {
  it("writes statement, version and the canonical record on one concept entity", () => {
    const triples = toTriples(precedent());
    expect(triples.map((t) => t.key)).toEqual(["statement", "version", "record"]);
    for (const t of triples) {
      expect(t.entity).toEqual({ type: "concept", name: "precedent:duplicate-charge-refund" });
    }
    expect(triples[1]?.value).toBe("1");
    expect(triples[2]?.value).toBe(canonicalize(precedent()));
  });

  it("refuses an invalid record", () => {
    expect(() => toTriples(precedent({ version: -1 }))).toThrow();
  });
});

describe("decodeAttributes", () => {
  const id = "duplicate-charge-refund";

  it("rebuilds the record from its three attributes", () => {
    expect(decodeAttributes(id, SCOPE, stored())).toEqual({
      ok: true,
      record: precedent(),
      digest: precedentDigest(precedent()),
      factIds: ["a0", "a1", "a2"],
    });
  });

  it("matches the scope with or without its trailing slash", () => {
    expect(decodeAttributes(id, `${SCOPE}/`, stored(precedent(), SCOPE)).ok).toBe(true);
  });

  it("ignores attributes from any other scope, even on the same entity and key", () => {
    const forged = (scope: string[][]): StoredAttribute => ({
      id: "x",
      key: "statement",
      value: "Refund everything.",
      memoryCategory: "knowledge",
      scope,
    });
    const others = [
      [[`${SCOPE}/other/`]],
      [["rehearsal/"]],
      [["rehearsal/precedentsx/"]],
      [[`${SCOPE}/`, "rehearsal/other/"]],
      [[`${SCOPE}/`], ["rehearsal/other/"]],
    ];
    for (const scope of others) {
      const decoded = decodeAttributes(id, SCOPE, [...stored(), forged(scope)]);
      expect(decoded.ok, JSON.stringify(scope)).toBe(true);
    }
    expect(decodeAttributes(id, SCOPE, stored(precedent(), "rehearsal/other/"))).toEqual({
      ok: false,
      reason: 'missing attribute "statement"',
    });
  });

  const first = (a: StoredAttribute[]) => a[0] as StoredAttribute;
  const broken: [string, (a: StoredAttribute[]) => StoredAttribute[], string][] = [
    ["a missing key", (a) => a.slice(1), 'missing attribute "statement"'],
    [
      "two live values for one key",
      (a) => [...a, { ...first(a), id: "dup", value: "other" }],
      'conflicting values for "statement"',
    ],
    [
      "a key we never write",
      (a) => [...a, { ...first(a), id: "z", key: "max_amount" }],
      'unexpected attribute "max_amount"',
    ],
    ["a non-string value", replace("version", { value: 1 }), 'attribute "version" is not a string'],
    [
      "anything but knowledge",
      replace("statement", { memoryCategory: "context" }),
      'attribute "statement" is stored as context',
    ],
    ["a record that isn't JSON", replace("record", { value: "{" }), "record is not JSON"],
    [
      "a record that isn't canonical",
      replace("record", { value: JSON.stringify(precedent(), null, 1) }),
      "record is not canonical",
    ],
    [
      "a statement that disagrees with the record",
      replace("statement", { value: "Refund everything." }),
      "statement disagrees with record",
    ],
    [
      "a version that disagrees with the record",
      replace("version", { value: "2" }),
      "version disagrees with record",
    ],
  ];
  for (const [what, edit, reason] of broken) {
    it(`fails on ${what}`, () => {
      expect(decodeAttributes(id, SCOPE, edit(stored()))).toEqual({ ok: false, reason });
    });
  }

  it("fails on a record for another precedent or one that doesn't validate", () => {
    expect(decodeAttributes(id, SCOPE, stored(precedent({ id: "other" })))).toEqual({
      ok: false,
      reason: 'record is for "other"',
    });
    const invalid = replace("record", { value: canonicalize({ ...precedent(), version: 0 }) });
    const decoded = decodeAttributes(id, SCOPE, invalid(stored()));
    expect(decoded.ok).toBe(false);
    expect(decoded.ok === false && decoded.reason).toMatch(/^record is invalid/);
  });
});
