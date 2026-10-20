/**
 * RFC 8785 (JSON Canonicalization Scheme) for the JSON values our contracts produce.
 * Object keys are sorted by UTF-16 code units; array order is preserved (workflow order matters).
 * Rejects values JSON can't represent faithfully instead of silently dropping them.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`cannot canonicalize number ${value}`);
      // ECMAScript Number serialization is exactly what RFC 8785 specifies (and -0 becomes "0").
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value
          .map((item) => {
            if (item === undefined) throw new TypeError("cannot canonicalize undefined in array");
            return canonicalize(item);
          })
          .join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`cannot canonicalize non-plain object (${proto?.constructor?.name})`);
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((k) => record[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(record[k])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`cannot canonicalize ${typeof value}`);
  }
}
