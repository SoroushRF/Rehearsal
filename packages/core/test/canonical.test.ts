import { describe, expect, it } from "vitest";
import { canonicalize } from "../src/canonical";

describe("canonicalize (RFC 8785)", () => {
  it("sorts object keys recursively and preserves array order", () => {
    expect(canonicalize({ b: 1, a: { d: [3, 1], c: true } })).toBe(
      '{"a":{"c":true,"d":[3,1]},"b":1}',
    );
  });

  it("sorts keys by UTF-16 code units", () => {
    // RFC 8785 §3.2.3 ordering: "\r" < "1" < U+0080 < "ö" < "€" < U+1F600 < U+FB33
    const emoji = "\u{1F600}";
    const dagesh = "\uFB33";
    const obj = { "€": 0, "\r": 0, [dagesh]: 0, "1": 0, [emoji]: 0, "\u0080": 0, ö: 0 };
    expect(canonicalize(obj)).toBe(
      `{"\\r":0,"1":0,"\u0080":0,"ö":0,"€":0,"${emoji}":0,"${dagesh}":0}`,
    );
  });

  it("serializes numbers like ECMAScript", () => {
    expect(canonicalize([-0, 1e21, 0.000001, 1e-7, 4210])).toBe("[0,1e+21,0.000001,1e-7,4210]");
  });

  it("omits undefined object members but rejects lossy values", () => {
    expect(canonicalize({ a: undefined, b: null })).toBe('{"b":null}');
    expect(() => canonicalize([undefined])).toThrow();
    expect(() => canonicalize(Number.NaN)).toThrow();
    expect(() => canonicalize(new Date(0))).toThrow();
  });
});
